#!/usr/bin/env python3
"""Local provider console dashboard."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from providers import ProviderError, ProviderManager, links_for_config, load_config, sync_browseros_profile

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_PORT = 19765


def json_bytes(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def public_configs() -> list[dict[str, object]]:
    return [
        {
            "id": config.id,
            "name": config.name,
            "type": config.type,
            "target_url": config.target_url,
            "enabled": config.enabled,
            "mode": config.mode,
            "links": links_for_config(config),
        }
        for config in load_config()
        if config.enabled
    ]


class DashboardHandler(BaseHTTPRequestHandler):
    manager = ProviderManager()

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
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(json_bytes(data), "application/json; charset=utf-8", status)

    def serve_static(self, path: str) -> None:
        relative = path[len("/static/") :] if path.startswith("/static/") else path.lstrip("/")
        if path == "/":
            file_path = STATIC_DIR / "index.html"
        else:
            file_path = (STATIC_DIR / relative).resolve()
            static_root = STATIC_DIR.resolve()
            if static_root not in file_path.parents and file_path != static_root:
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
        path = urlparse(self.path).path
        if path == "/" or path.startswith("/static/"):
            self.serve_static(path)
            return
        if path == "/api/providers":
            self.send_json({"providers": self.manager.list_snapshots(), "configs": public_configs()})
            return
        if path.startswith("/dumps/"):
            self.serve_dump(path)
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_HEAD(self) -> None:
        path = urlparse(self.path).path
        if path == "/" or path.startswith("/static/"):
            self.send_response(HTTPStatus.OK)
            if path == "/" or path.endswith(".html"):
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
                self.send_json({"providers": self.manager.refresh_all()})
            except Exception as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
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
    print(f"[server] http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
