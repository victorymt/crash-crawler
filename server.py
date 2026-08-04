#!/usr/bin/env python3
"""Local provider console dashboard."""

from __future__ import annotations

import argparse
import copy
import json
import mimetypes
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from channels import available_channel_models, rank_available_channels, summarize_channel_refresh
from providers import (
    ProviderError,
    ProviderManager,
    delete_local_secret,
    links_for_config,
    load_local_secret,
    set_local_secret,
    sync_browseros_profile,
)
from web_store import ConfigStore

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_PORT = 19765


def json_bytes(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def public_configs(configs, enabled_only: bool = False) -> list[dict[str, object]]:
    return [
        {
            **config.to_dict(),
            "links": links_for_config(config),
        }
        for config in configs
        if config.enabled or not enabled_only
    ]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RefreshJobManager:
    """Run one refresh batch in the background and expose its live progress."""

    def __init__(self, manager: ProviderManager) -> None:
        self.manager = manager
        self._lock = threading.RLock()
        self._job: dict[str, object] | None = None

    def start(self) -> tuple[dict[str, object], bool]:
        with self._lock:
            if self._job and self._job["status"] == "running":
                return copy.deepcopy(self._job), False

            configs = self.manager.enabled_configs()
            job_id = uuid.uuid4().hex
            self._job = {
                "id": job_id,
                "status": "running",
                "total": len(configs),
                "completed": 0,
                "successCount": 0,
                "failureCount": 0,
                "startedAt": utc_now(),
                "finishedAt": None,
                "error": None,
                "providers": [
                    {
                        "id": config.id,
                        "name": config.name,
                        "status": "queued",
                        "error": None,
                    }
                    for config in configs
                ],
            }
            thread = threading.Thread(
                target=self._run,
                args=(job_id,),
                name=f"provider-refresh-{job_id[:8]}",
                daemon=True,
            )
            thread.start()
            return copy.deepcopy(self._job), True

    def current(self) -> dict[str, object] | None:
        with self._lock:
            return copy.deepcopy(self._job)

    def _progress(self, job_id: str, event: str, config, snapshot) -> None:
        with self._lock:
            if not self._job or self._job["id"] != job_id:
                return
            item = next(
                (row for row in self._job["providers"] if row["id"] == config.id),
                None,
            )
            if not item:
                return
            if event == "started":
                item["status"] = "refreshing"
                return
            if event != "completed" or item["status"] in {"succeeded", "failed"}:
                return
            failed = not snapshot or snapshot.get("status") != "ok"
            item["status"] = "failed" if failed else "succeeded"
            item["error"] = snapshot.get("error") if failed and snapshot else None
            self._job["completed"] += 1
            counter = "failureCount" if failed else "successCount"
            self._job[counter] += 1

    def _run(self, job_id: str) -> None:
        try:
            self.manager.refresh_all(
                progress=lambda event, config, snapshot: self._progress(
                    job_id, event, config, snapshot
                )
            )
        except Exception as exc:
            with self._lock:
                if not self._job or self._job["id"] != job_id:
                    return
                for item in self._job["providers"]:
                    if item["status"] not in {"succeeded", "failed"}:
                        item["status"] = "failed"
                        item["error"] = str(exc)
                        self._job["completed"] += 1
                        self._job["failureCount"] += 1
                self._job["status"] = "failed"
                self._job["error"] = str(exc)
                self._job["finishedAt"] = utc_now()
            return

        with self._lock:
            if self._job and self._job["id"] == job_id:
                self._job["status"] = "completed"
                self._job["finishedAt"] = utc_now()


class AutoRefreshScheduler:
    def __init__(self, manager: ProviderManager) -> None:
        self.manager = manager
        self.minutes = 0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="provider-auto-refresh", daemon=True)

    def start(self, minutes: int = 0) -> None:
        self.minutes = minutes
        if not self._thread.is_alive():
            self._thread.start()

    def configure(self, minutes: int) -> None:
        self.minutes = minutes
        self._wake.set()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread.is_alive():
            self._thread.join(timeout=2)

    def _run(self) -> None:
        while not self._stop.is_set():
            interval = max(0, self.minutes) * 60
            if not interval:
                self._wake.wait()
                self._wake.clear()
                continue
            if self._wake.wait(interval):
                self._wake.clear()
                continue
            try:
                self.manager.refresh_all()
            except Exception as exc:
                print(f"[server] automatic refresh failed: {exc}")


class DashboardHandler(BaseHTTPRequestHandler):
    store = ConfigStore()
    manager = ProviderManager(configs=store.snapshot()[0])
    refresh_jobs = RefreshJobManager(manager)
    scheduler: AutoRefreshScheduler | None = None

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")

    def send_bytes(
        self,
        content: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(json_bytes(data), "application/json; charset=utf-8", status)

    def read_json(self, max_bytes: int = 1024 * 1024) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length <= 0 or length > max_bytes:
            raise ValueError("request body must be between 1 byte and 1 MiB")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        return data

    def send_api_error(self, exc: Exception) -> None:
        if isinstance(exc, KeyError):
            self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        elif isinstance(exc, (ValueError, ProviderError, json.JSONDecodeError)):
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        else:
            self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def apply_configs(self, configs) -> list[dict[str, object]]:
        self.manager.replace_configs(configs)
        return public_configs(configs)

    def serve_static(self, path: str) -> None:
        relative = path[len("/static/") :] if path.startswith("/static/") else path.lstrip("/")
        aliases = {
            "/": "index.html",
            "/channels": "channels.html",
            "/settings": "settings.html",
        }
        if path in aliases:
            file_path = STATIC_DIR / aliases[path]
        elif path.startswith("/static/"):
            file_path = (STATIC_DIR / relative).resolve()
            static_root = STATIC_DIR.resolve()
            if static_root not in file_path.parents and file_path != static_root:
                self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
        else:
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        if not file_path.is_file():
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type = f"{content_type}; charset=utf-8"
        self.send_bytes(file_path.read_bytes(), content_type)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path in {"/", "/channels", "/settings"} or path.startswith("/static/"):
            self.serve_static(path)
            return
        if path == "/api/providers":
            configs, settings = self.store.snapshot()
            self.send_json({
                "providers": self.manager.list_snapshots(),
                "configs": public_configs(configs, enabled_only=True),
                "settings": settings,
            })
            return
        if path == "/api/refresh":
            self.send_json({"refresh": self.refresh_jobs.current()})
            return
        if path == "/api/config":
            configs, settings = self.store.snapshot()
            self.send_json({
                "configs": public_configs(configs),
                "settings": settings,
                "has_deepseek_key": bool(load_local_secret("deepseek_api_key")),
            })
            return
        if path == "/api/channels":
            query = parse_qs(parsed.query)
            selected_model = str(query.get("model", [""])[0])
            include_degraded = str(query.get("include_degraded", [""])[0]).lower() in {"1", "true", "yes"}
            snapshots = self.manager.list_snapshots()
            candidates = rank_available_channels(
                snapshots,
                selected_model,
                statuses=("operational", "degraded") if include_degraded else ("operational",),
            )
            self.send_json({
                "channels": candidates,
                "models": available_channel_models(snapshots),
                "summary": summarize_channel_refresh(snapshots),
            })
            return
        if path.startswith("/dumps/"):
            self.serve_dump(path)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/channels", "/settings"} or path.startswith("/static/"):
            self.send_response(HTTPStatus.OK)
            if path in {"/", "/channels", "/settings"} or path.endswith(".html"):
                self.send_header("Content-Type", "text/html; charset=utf-8")
            elif path.endswith(".css"):
                self.send_header("Content-Type", "text/css; charset=utf-8")
            elif path.endswith(".js"):
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.end_headers()
            return
        if path == "/api/providers":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/sync-auth":
            try:
                self.send_json(sync_browseros_profile())
            except ProviderError as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/refresh":
            try:
                refresh, created = self.refresh_jobs.start()
                self.send_json(
                    {"refresh": refresh, "started": created},
                    HTTPStatus.ACCEPTED if created else HTTPStatus.OK,
                )
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/refresh-channels":
            try:
                providers = self.manager.refresh_channels()
                self.send_json({"providers": providers, "summary": summarize_channel_refresh(providers)})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/config/provider":
            try:
                provider = self.store.upsert(self.read_json().get("provider"))
                configs, _ = self.store.snapshot()
                self.apply_configs(configs)
                self.send_json({"provider": public_configs([provider])[0], "configs": public_configs(configs)})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/config/providers":
            try:
                payload = self.read_json()
                if not isinstance(payload.get("providers"), list):
                    raise ValueError("providers must be an array")
                configs = self.store.replace(payload["providers"])
                self.send_json({"configs": self.apply_configs(configs)})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/config/settings":
            try:
                settings = self.store.save_settings(self.read_json().get("settings"))
                if self.scheduler:
                    self.scheduler.configure(settings["auto_refresh_minutes"])
                self.send_json({"settings": settings})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/secrets/deepseek":
            try:
                value = str(self.read_json().get("value") or "").strip()
                if not value:
                    raise ValueError("DeepSeek API key cannot be empty")
                set_local_secret("deepseek_api_key", value)
                self.send_json({"ok": True})
            except Exception as exc:
                self.send_api_error(exc)
            return
        prefix = "/api/providers/"
        suffix = "/refresh"
        if path.startswith(prefix) and path.endswith(suffix):
            provider_id = unquote(path[len(prefix) : -len(suffix)].strip("/"))
            try:
                self.send_json({"provider": self.manager.refresh(provider_id)})
            except KeyError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/secrets/deepseek":
            delete_local_secret("deepseek_api_key")
            self.send_json({"ok": True})
            return
        prefix = "/api/config/providers/"
        if path.startswith(prefix):
            try:
                provider_id = unquote(path[len(prefix):].strip("/"))
                configs = self.store.delete(provider_id)
                self.send_json({"configs": self.apply_configs(configs)})
            except Exception as exc:
                self.send_api_error(exc)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def serve_dump(self, path: str) -> None:
        dump_path = (ROOT / path.lstrip("/")).resolve()
        dump_root = (ROOT / "dumps").resolve()
        if dump_root not in dump_path.parents or not dump_path.exists():
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(dump_path))[0] or "text/plain; charset=utf-8"
        self.send_bytes(dump_path.read_bytes(), content_type)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), DashboardHandler)
    scheduler = AutoRefreshScheduler(DashboardHandler.manager)
    DashboardHandler.scheduler = scheduler
    scheduler.start(DashboardHandler.store.snapshot()[1]["auto_refresh_minutes"])
    print(f"[server] http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.close()
        server.server_close()


if __name__ == "__main__":
    main()
