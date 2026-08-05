#!/usr/bin/env python3
"""Local provider console dashboard."""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import inspect
import json
import mimetypes
import os
import secrets
import threading
import tempfile
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from channels import available_channel_models, available_channel_providers, list_channels, summarize_channel_refresh
from provider_definitions import (
    PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH,
    provider_definition_documents,
    provider_supports_capability,
)
from providers import (
    PROVIDER_SCHEMA_VERSION,
    ProviderError,
    ProviderManager,
    RefreshBusyError,
    delete_local_secret,
    links_for_config,
    load_local_secret,
    load_provider_auth_session,
    provider_auth_origin,
    provider_auth_session_lock,
    save_provider_auth_session,
    set_local_secret,
    sync_browseros_auth_sessions,
)
from provider_auth import (
    AUTH_SOURCE_LOCAL_SYNC,
    normalize_provider_auth_origin,
    normalize_provider_auth_session,
    provider_auth_session_is_stale,
)
from web_store import ConfigStore, providers_from_import_document

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_PORT = 19765
LOCAL_SYNC_TOKEN_SECRET = "local_sync_token"
REFRESH_JOB_FILE = Path(os.environ.get("PROVIDER_REFRESH_JOB", ROOT / ".refresh-job.json"))
CHANNEL_REFRESH_JOB_FILE = Path(
    os.environ.get("PROVIDER_CHANNEL_REFRESH_JOB", ROOT / ".refresh-channel-job.json")
)


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


def config_revision(configs) -> str:
    payload = [config.to_portable_dict() for config in configs]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def get_or_create_local_sync_token() -> str:
    token = load_local_secret(LOCAL_SYNC_TOKEN_SECRET)
    if token:
        return token
    token = secrets.token_urlsafe(32)
    set_local_secret(LOCAL_SYNC_TOKEN_SECRET, token)
    return token


class SyncAuthError(ProviderError):
    pass


class HostValidationError(ProviderError):
    pass


class SyncRevisionConflict(ProviderError):
    pass


class RefreshJobManager:
    """Run one refresh batch in the background and expose its live progress."""

    def __init__(
        self,
        manager: ProviderManager,
        job_file: Path = REFRESH_JOB_FILE,
        operation: str = "all",
    ) -> None:
        self.manager = manager
        self.job_file = Path(job_file)
        self.operation = operation
        self._lock = threading.RLock()
        self._cancel_event: threading.Event | None = None
        self._job: dict[str, object] | None = self._load()
        if self._job and self._job.get("status") in {"running", "cancelling"}:
            self._job["status"] = "interrupted"
            self._job["error"] = "服务重启导致刷新任务中断"
            self._job["finishedAt"] = utc_now()
            self._persist()

    def _load(self) -> dict[str, object] | None:
        try:
            data = json.loads(self.job_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) and data.get("id") else None

    def _persist(self) -> None:
        if self._job is None:
            return
        self.job_file.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{self.job_file.name}.", suffix=".tmp", dir=self.job_file.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self._job, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.job_file)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def start(
        self,
        source: str = "manual",
        configs=None,
    ) -> tuple[dict[str, object], bool]:
        with self._lock:
            if self._job and self._job["status"] in {"running", "cancelling"}:
                return copy.deepcopy(self._job), False
            active = self.manager.active_refresh()
            if active:
                raise RefreshBusyError(f"refresh already running: {active}")

            if configs is None:
                configs = (
                    self.manager.enabled_configs()
                    if self.operation == "all"
                    else self.manager.channel_configs()
                )
            else:
                configs = copy.deepcopy([config for config in configs if config.enabled])
            job_id = uuid.uuid4().hex
            self._job = {
                "id": job_id,
                "status": "running",
                "source": source,
                "total": len(configs),
                "completed": 0,
                "successCount": 0,
                "failureCount": 0,
                "cancelledCount": 0,
                "startedAt": utc_now(),
                "finishedAt": None,
                "cancelRequestedAt": None,
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
            cancel_event = threading.Event()
            self._cancel_event = cancel_event
            self._persist()
            thread = threading.Thread(
                target=self._run,
                args=(job_id, configs, cancel_event),
                name=f"provider-refresh-{job_id[:8]}",
                daemon=True,
            )
            thread.start()
            return copy.deepcopy(self._job), True

    def retry_failed(self) -> tuple[dict[str, object] | None, bool]:
        with self._lock:
            if not self._job or self._job.get("status") in {"running", "cancelling"}:
                return copy.deepcopy(self._job), False
            failed_ids = {
                item.get("id")
                for item in self._job.get("providers", [])
                if item.get("status") == "failed"
            }
            available_configs = (
                self.manager.enabled_configs()
                if self.operation == "all"
                else self.manager.channel_configs()
            )
            configs = [
                config for config in available_configs
                if config.id in failed_ids
            ]
            if not configs:
                return copy.deepcopy(self._job), False
        return self.start(source="retry", configs=configs)

    def cancel(self) -> tuple[dict[str, object] | None, bool]:
        with self._lock:
            if not self._job or self._job.get("status") not in {"running", "cancelling"}:
                return copy.deepcopy(self._job), False
            if self._cancel_event:
                self._cancel_event.set()
            if self._job.get("status") == "running":
                self._job["status"] = "cancelling"
                self._job["cancelRequestedAt"] = utc_now()
                self._persist()
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
                self._persist()
                return
            if event != "completed" or item["status"] in {"succeeded", "failed", "cancelled"}:
                return
            if snapshot and snapshot.get("status") == "cancelled":
                item["status"] = "cancelled"
                item["error"] = snapshot.get("error") or "刷新已取消"
                self._job["completed"] += 1
                self._job["cancelledCount"] += 1
                self._persist()
                return
            failed = not snapshot or snapshot.get("status") != "ok"
            if self.operation == "channels" and snapshot:
                failed = bool(
                    failed
                    or snapshot.get("channelError")
                    or snapshot.get("channelsStale") is True
                )
            item["status"] = "failed" if failed else "succeeded"
            item["error"] = (
                snapshot.get("error") or snapshot.get("channelError")
                if failed and snapshot
                else None
            )
            self._job["completed"] += 1
            counter = "failureCount" if failed else "successCount"
            self._job[counter] += 1
            self._persist()

    def _run(self, job_id: str, configs, cancel_event: threading.Event) -> None:
        try:
            refresh_kwargs = {
                "progress": lambda event, config, snapshot: self._progress(
                    job_id, event, config, snapshot
                ),
                "configs": configs,
            }
            refresh_method = getattr(self.manager, "refresh_channels" if self.operation == "channels" else "refresh_all")
            if "cancel_event" in inspect.signature(refresh_method).parameters:
                refresh_kwargs["cancel_event"] = cancel_event
            refresh_method(**refresh_kwargs)
        except Exception as exc:
            with self._lock:
                if not self._job or self._job["id"] != job_id:
                    return
                for item in self._job["providers"]:
                    if item["status"] not in {"succeeded", "failed", "cancelled"}:
                        item["status"] = "cancelled" if cancel_event.is_set() else "failed"
                        item["error"] = "刷新已取消" if cancel_event.is_set() else str(exc)
                        self._job["completed"] += 1
                        self._job["cancelledCount" if cancel_event.is_set() else "failureCount"] += 1
                self._job["status"] = "cancelled" if cancel_event.is_set() else "failed"
                self._job["error"] = str(exc)
                self._job["finishedAt"] = utc_now()
                self._persist()
            return

        with self._lock:
            if self._job and self._job["id"] == job_id:
                self._job["status"] = "cancelled" if cancel_event.is_set() else "completed"
                if cancel_event.is_set():
                    self._job["error"] = "刷新已取消"
                self._job["finishedAt"] = utc_now()
                self._persist()
                self._cancel_event = None


class AutoRefreshScheduler:
    def __init__(self, refresh_jobs: RefreshJobManager) -> None:
        self.refresh_jobs = refresh_jobs
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
                self.refresh_jobs.start(source="automatic")
            except Exception as exc:
                print(f"[server] automatic refresh failed: {exc}")


class DashboardHandler(BaseHTTPRequestHandler):
    store = ConfigStore()
    manager = ProviderManager(configs=store.snapshot()[0])
    refresh_jobs = RefreshJobManager(manager)
    channel_refresh_jobs = RefreshJobManager(
        manager, job_file=CHANNEL_REFRESH_JOB_FILE, operation="channels"
    )
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
        if self.command != "HEAD":
            self.wfile.write(content)

    def send_json(self, data: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(json_bytes(data), "application/json; charset=utf-8", status)

    def read_json(self, max_bytes: int = 1024 * 1024) -> dict:
        data = self.read_json_value(max_bytes)
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        return data

    def read_json_value(self, max_bytes: int = 1024 * 1024):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length <= 0 or length > max_bytes:
            raise ValueError("request body must be between 1 byte and 1 MiB")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        return data

    def send_api_error(self, exc: Exception) -> None:
        payload = {"error": str(exc)}
        error_code = str(getattr(exc, "code", "") or "").strip()
        if error_code:
            payload["code"] = error_code
        if isinstance(exc, HostValidationError):
            self.send_json(payload, HTTPStatus.FORBIDDEN)
        elif isinstance(exc, SyncAuthError):
            self.send_json(payload, HTTPStatus.UNAUTHORIZED)
        elif isinstance(exc, SyncRevisionConflict):
            self.send_json(payload, HTTPStatus.CONFLICT)
        elif isinstance(exc, RefreshBusyError):
            self.send_json(payload, HTTPStatus.CONFLICT)
        elif isinstance(exc, KeyError):
            self.send_json(payload, HTTPStatus.NOT_FOUND)
        elif isinstance(exc, (ValueError, ProviderError, json.JSONDecodeError)):
            self.send_json(payload, HTTPStatus.BAD_REQUEST)
        else:
            self.send_json(payload, HTTPStatus.INTERNAL_SERVER_ERROR)

    def require_sync_token(self) -> None:
        expected = get_or_create_local_sync_token()
        provided = self.headers.get("X-Provider-Sync-Token") or ""
        if not provided or not hmac.compare_digest(provided, expected):
            raise SyncAuthError("invalid local sync token")

    def require_loopback_host(self) -> None:
        raw_host = str(self.headers.get("Host") or "").strip()
        try:
            parsed = urlparse(f"//{raw_host}")
            hostname = (parsed.hostname or "").lower()
            _ = parsed.port
        except ValueError as exc:
            raise HostValidationError("invalid Host header") from exc
        if (
            not raw_host
            or hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username is not None
            or parsed.password is not None
            or bool(parsed.path or parsed.params or parsed.query or parsed.fragment)
        ):
            raise HostValidationError("Host must be a loopback address")

    def authorize_request(self, mutation: bool = False) -> bool:
        try:
            self.require_loopback_host()
            if mutation:
                self.require_sync_token()
            return True
        except Exception as exc:
            self.send_api_error(exc)
            return False

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
        if not self.authorize_request():
            return
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
        if path == "/api/health":
            self.send_json({
                "ok": True,
                "service": "provider-usage-hub",
                "schemaVersion": PROVIDER_SCHEMA_VERSION,
                "pid": os.getpid(),
            })
            return
        if path == "/api/refresh":
            self.send_json({"refresh": self.refresh_jobs.current()})
            return
        if path == "/api/refresh-channels":
            self.send_json({"refresh": self.channel_refresh_jobs.current()})
            return
        if path == "/api/config":
            configs, settings = self.store.snapshot()
            self.send_json({
                "configs": public_configs(configs),
                "settings": settings,
                "revision": config_revision(configs),
                "has_deepseek_key": bool(load_local_secret("deepseek_api_key")),
                "providerDefinitions": provider_definition_documents(),
            })
            return
        if path == "/api/local-sync/token":
            configs, _ = self.store.snapshot()
            self.send_json({
                "token": get_or_create_local_sync_token(),
                "revision": config_revision(configs),
            })
            return
        if path == "/api/local-sync/config":
            try:
                self.require_sync_token()
                configs, _ = self.store.snapshot()
                self.send_json({
                    "schemaVersion": 4,
                    "revision": config_revision(configs),
                    "providers": [config.to_portable_dict() for config in configs],
                })
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/channels":
            query = parse_qs(parsed.query)
            selected_model = str(query.get("model", [""])[0])
            selected_status = str(query.get("status", [""])[0]).strip()
            rate_mode = str(query.get("rate", ["all"])[0]).strip() or "all"
            provider_id = str(query.get("provider", [""])[0]).strip()
            availability = str(query.get("availability", ["all"])[0]).strip() or "all"
            # Keep the legacy parameter compatible without changing the new default
            # (all channels). Its presence, including an explicit false value,
            # means the caller still expects the old operational/degraded view.
            has_legacy_status_filter = "include_degraded" in query
            include_degraded = str(query.get("include_degraded", [""])[0]).lower() in {"1", "true", "yes"}
            has_new_channel_filter = any(key in query for key in ("status", "rate", "availability", "provider"))
            legacy_available_mode = has_legacy_status_filter and not has_new_channel_filter
            snapshots = self.manager.list_snapshots()
            statuses = [selected_status] if selected_status else (
                (["operational", "degraded"] if include_degraded else ["operational"])
                if has_legacy_status_filter else None
            )
            effective_rate_mode = "known" if legacy_available_mode else rate_mode
            candidates = list_channels(
                snapshots,
                selected_model,
                statuses=statuses,
                rate_mode=effective_rate_mode if effective_rate_mode in {"all", "known", "unknown"} else "all",
                provider_id=provider_id,
                availability_only=availability == "available",
            )
            if legacy_available_mode:
                candidates = [
                    channel for channel in candidates
                    if channel.get("providerStatus") == "ok"
                    and channel.get("channelsStale") is not True
                    and channel.get("balanceAvailable")
                ]
            self.send_json({
                "channels": candidates,
                "models": available_channel_models(snapshots),
                "providers": available_channel_providers(snapshots),
                "summary": summarize_channel_refresh(snapshots),
            })
            return
        if path.startswith("/dumps/"):
            self.serve_dump(path)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_HEAD(self) -> None:
        if not self.authorize_request():
            return
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
        if not self.authorize_request(mutation=True):
            return
        path = urlparse(self.path).path
        if path == "/api/local-sync/token":
            try:
                if self.headers.get("X-Local-Sync-Rotate") != "1":
                    raise SyncAuthError("token rotation requires explicit confirmation")
                token = secrets.token_urlsafe(32)
                set_local_secret(LOCAL_SYNC_TOKEN_SECRET, token)
                configs, _ = self.store.snapshot()
                self.send_json({"token": token, "revision": config_revision(configs)})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path in {"/api/local-sync/preview", "/api/local-sync/apply"}:
            try:
                self.require_sync_token()
                payload = self.read_json()
                document = payload.get("document", payload.get("config"))
                providers = providers_from_import_document(document)
                mode = str(payload.get("importMode") or payload.get("mode") or "merge")
                configs, _ = self.store.snapshot()
                current_revision = config_revision(configs)
                if path.endswith("/apply"):
                    expected = str(payload.get("expectedRevision") or "")
                    if not expected or expected != current_revision:
                        raise SyncRevisionConflict(
                            f"configuration changed; expected {expected or 'missing'}, current {current_revision}"
                        )
                    next_configs, summary = self.store.import_configs(providers, mode=mode)
                    self.apply_configs(next_configs)
                    new_revision = config_revision(next_configs)
                    self.send_json({
                        "ok": True,
                        "revision": new_revision,
                        "summary": summary,
                        "providers": [config.to_portable_dict() for config in next_configs],
                    })
                else:
                    next_configs, summary = self.store.preview_import(providers, mode=mode)
                    self.send_json({
                        "revision": current_revision,
                        "summary": summary,
                        "nextRevision": config_revision(next_configs),
                    })
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/local-sync/auth":
            try:
                self.require_sync_token()
                payload = self.read_json()
                sessions = payload.get("sessions", [])
                if not isinstance(sessions, list) or len(sessions) > 100:
                    raise ValueError("sessions must be an array with at most 100 items")
                configs, _ = self.store.snapshot()
                configs_by_id = {config.id: config for config in configs}
                synced = []
                stale = []
                for item in sessions:
                    if not isinstance(item, dict):
                        raise ValueError("auth session must be an object")
                    provider_id = str(item.get("providerId") or "").strip()
                    config = configs_by_id.get(provider_id)
                    if not config or not provider_supports_capability(
                        config.type, PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH
                    ):
                        raise ValueError(f"unsupported auth session provider: {provider_id}")
                    supplied = urlparse(str(item.get("origin") or ""))
                    expected_origin = provider_auth_origin(config)
                    supplied_origin = normalize_provider_auth_origin(
                        str(item.get("origin") or "")
                    )
                    if (
                        not supplied_origin
                        or supplied.username is not None
                        or supplied.password is not None
                        or supplied_origin != expected_origin
                    ):
                        raise ValueError(f"auth session origin does not match Provider {provider_id}")
                    auth_token = str(item.get("authToken") or "").strip()
                    refresh_token = str(item.get("refreshToken") or "").strip()
                    expires_at = str(item.get("expiresAt") or "").strip()
                    if not auth_token and not refresh_token:
                        continue
                    if len(auth_token) > 8192 or len(refresh_token) > 8192 or len(expires_at) > 128:
                        raise ValueError(f"auth session is too large for Provider {provider_id}")
                    user_id = str(item.get("userId") or "").strip()
                    username = str(item.get("username") or "").strip()
                    if len(user_id) > 256 or len(username) > 256:
                        raise ValueError(f"auth identity is too large for Provider {provider_id}")
                    incoming = normalize_provider_auth_session({
                        **item,
                        "providerId": provider_id,
                        "origin": expected_origin,
                        "userId": user_id,
                        "username": username,
                        "authToken": auth_token,
                        "refreshToken": refresh_token,
                        "expiresAt": expires_at,
                        "source": AUTH_SOURCE_LOCAL_SYNC,
                        "updatedAt": item.get("updatedAt") or utc_now(),
                    })
                    with provider_auth_session_lock(provider_id):
                        current = load_provider_auth_session(config)
                        if provider_auth_session_is_stale(current, incoming):
                            stale.append(provider_id)
                            continue
                        save_provider_auth_session(config, incoming)
                    synced.append(provider_id)
                self.send_json({
                    "ok": True,
                    "synced": len(synced),
                    "stale": len(stale),
                    "providers": synced,
                    "staleProviders": stale,
                })
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/sync-auth":
            try:
                configs, _ = self.store.snapshot()
                result = {
                    "ok": True,
                    "mode": "live_browseros",
                    "authSessions": sync_browseros_auth_sessions(configs),
                }
                self.send_json(result)
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
                self.send_api_error(exc)
            return
        if path == "/api/refresh/cancel":
            try:
                refresh, cancelled = self.refresh_jobs.cancel()
                self.send_json({"refresh": refresh, "cancelled": cancelled})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/refresh/retry":
            try:
                refresh, created = self.refresh_jobs.retry_failed()
                self.send_json(
                    {"refresh": refresh, "started": created},
                    HTTPStatus.ACCEPTED if created else HTTPStatus.OK,
                )
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/refresh-channels":
            try:
                refresh, created = self.channel_refresh_jobs.start(source="manual")
                self.send_json(
                    {"refresh": refresh, "started": created},
                    HTTPStatus.ACCEPTED if created else HTTPStatus.OK,
                )
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/refresh-channels/cancel":
            try:
                refresh, cancelled = self.channel_refresh_jobs.cancel()
                self.send_json({"refresh": refresh, "cancelled": cancelled})
            except Exception as exc:
                self.send_api_error(exc)
            return
        if path == "/api/refresh-channels/retry":
            try:
                refresh, created = self.channel_refresh_jobs.retry_failed()
                self.send_json(
                    {"refresh": refresh, "started": created},
                    HTTPStatus.ACCEPTED if created else HTTPStatus.OK,
                )
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
                payload = self.read_json_value()
                providers = providers_from_import_document(payload)
                mode = "replace"
                if isinstance(payload, dict) and isinstance(payload.get("providers"), list):
                    mode = str(payload.get("importMode", payload.get("mode")) or "replace")
                configs, summary = self.store.import_configs(providers, mode=mode)
                self.send_json({"configs": self.apply_configs(configs), "summary": summary})
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
            except Exception as exc:
                self.send_api_error(exc)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        if not self.authorize_request(mutation=True):
            return
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
    scheduler = AutoRefreshScheduler(DashboardHandler.refresh_jobs)
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
