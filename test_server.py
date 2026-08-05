import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from providers import ProviderManager
from provider_auth import ProviderAuthSessionError
from server import DashboardHandler, RefreshJobManager
from web_store import ConfigStore


class ServerApiTests(unittest.TestCase):
    def setUp(self):
        self.sync_token = "test-local-sync-token"
        self.sync_token_patcher = patch(
            "server.get_or_create_local_sync_token", return_value=self.sync_token
        )
        self.sync_token_patcher.start()
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        config_path = root / "providers.json"
        config_path.write_text(json.dumps({"providers": [{
            "id": "deepseek",
            "name": "DeepSeek",
            "type": "deepseek",
            "target_url": "https://platform.deepseek.com/usage",
            "mode": "api",
        }, {
            "id": "channel-test",
            "name": "Channel Test",
            "type": "sub2api",
            "target_url": "https://channel.example/dashboard",
        }]}), encoding="utf-8")

        store = ConfigStore(config_path)
        manager = ProviderManager(configs=store.snapshot()[0], cache_file=root / "cache.json")
        manager.cache = {"providers": {
            "channel-test": {
                "id": "channel-test",
                "name": "Channel Test",
                "type": "sub2api",
                "status": "ok",
                "balances": [{"key": "balance", "value": "5.00"}],
                "channels": [{
                    "providerId": "channel-test",
                    "providerName": "Channel Test",
                    "name": "Low Rate",
                    "models": ["model-a"],
                    "primaryModel": "model-a",
                    "status": "operational",
                    "effectiveMultiplier": 0.1,
                    "timeline": [],
                }, {
                    "providerId": "channel-test",
                    "providerName": "Channel Test",
                    "name": "Degraded Rate",
                    "models": ["model-a"],
                    "primaryModel": "model-a",
                    "status": "degraded",
                    "effectiveMultiplier": "0.2",
                    "timeline": [],
                }, {
                    "providerId": "channel-test",
                    "providerName": "Channel Test",
                    "name": "Unknown Rate",
                    "models": ["model-a"],
                    "primaryModel": "model-a",
                    "status": "error",
                    "effectiveMultiplier": None,
                    "timeline": [],
                }],
                "channelCheckedAt": "2026-08-03T12:00:00+08:00",
                "channelsStale": False,
                "channelError": None,
            }
        }}

        class TestHandler(DashboardHandler):
            pass

        TestHandler.store = store
        TestHandler.manager = manager
        TestHandler.refresh_jobs = RefreshJobManager(manager, job_file=root / "refresh-job.json")
        TestHandler.channel_refresh_jobs = RefreshJobManager(
            manager, job_file=root / "channel-refresh-job.json", operation="channels"
        )
        TestHandler.scheduler = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()
        self.sync_token_patcher.stop()

    def request(self, path, method="GET", data=None, headers=None, authenticate=True):
        body = json.dumps(data).encode("utf-8") if data is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if method not in {"GET", "HEAD"} and authenticate:
            request_headers.setdefault("X-Provider-Sync-Token", self.sync_token)
        request = Request(
            self.base_url + path,
            data=body,
            method=method,
            headers=request_headers,
        )
        try:
            response = urlopen(request, timeout=3)
            return response.status, json.loads(response.read())
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_mutations_require_token_and_requests_require_loopback_host(self):
        status, result = self.request("/api/refresh", "POST", authenticate=False)
        self.assertEqual(status, 401)
        self.assertIn("token", result["error"])

        status, result = self.request("/api/config", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)
        self.assertIn("loopback", result["error"])

        status, result = self.request("/api/config/settings", "POST", {
            "settings": {"auto_refresh_minutes": 30}
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["settings"]["auto_refresh_minutes"], 30)

        status, result = self.request(
            "/api/local-sync/token",
            "POST",
            {},
            {"X-Local-Sync-Rotate": "1"},
            authenticate=False,
        )
        self.assertEqual(status, 401)

    def test_config_and_channel_endpoints(self):
        status, config = self.request("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in config["configs"]], ["deepseek", "channel-test"])

        status, channels = self.request("/api/channels?model=model-a")
        self.assertEqual(status, 200)
        self.assertEqual(channels["models"], ["model-a"])
        self.assertEqual(channels["channels"][0]["effectiveMultiplier"], 0.1)
        self.assertEqual(len(channels["channels"]), 3)
        self.assertEqual(channels["channels"][1]["effectiveMultiplier"], 0.2)
        self.assertIsNone(channels["channels"][2]["effectiveMultiplier"])
        self.assertEqual(channels["summary"]["providerCount"], 1)
        self.assertEqual(channels["summary"]["latestCheckedAt"], "2026-08-03T12:00:00+08:00")
        self.assertEqual(channels["providers"][0]["id"], "channel-test")
        self.assertEqual(channels["providers"][0]["channelCount"], 3)
        self.assertEqual(channels["providers"][0]["status"], "ok")

        status, legacy_operational = self.request("/api/channels?model=model-a&include_degraded=0")
        self.assertEqual(status, 200)
        self.assertEqual(len(legacy_operational["channels"]), 1)

        status, legacy_degraded = self.request("/api/channels?model=model-a&include_degraded=1")
        self.assertEqual(status, 200)
        self.assertEqual(
            [item["resolvedStatus"] for item in legacy_degraded["channels"]],
            ["operational", "degraded"],
        )

    def test_channel_endpoint_exposes_provider_without_channel_rows(self):
        manager = self.server.RequestHandlerClass.manager
        manager.cache["providers"]["channel-test"] = {
            "id": "channel-test",
            "name": "Channel Test",
            "type": "sub2api",
            "status": "needs_login",
            "url": "https://channel.example/dashboard",
            "error": "login required",
            "channels": [],
            "channelCheckedAt": None,
            "channelsStale": False,
        }
        status, result = self.request("/api/channels")
        self.assertEqual(status, 200)
        self.assertEqual(result["channels"], [])
        self.assertEqual(result["providers"][0]["id"], "channel-test")
        self.assertEqual(result["providers"][0]["status"], "needs_login")
        self.assertEqual(result["providers"][0]["channelCount"], 0)

    def test_provider_update_order_settings_and_validation(self):
        status, result = self.request("/api/config/provider", "POST", {"provider": {
            "id": "newapi",
            "name": "New API",
            "type": "newapi",
            "targetUrl": "https://new.example/dashboard",
            "group": "常用",
        }})
        self.assertEqual(status, 200)
        self.assertEqual(result["provider"]["group"], "常用")

        reordered = list(reversed(result["configs"]))
        status, result = self.request("/api/config/providers", "POST", {"providers": reordered})
        self.assertEqual(status, 200)
        self.assertEqual(result["configs"][0]["id"], "newapi")

        status, result = self.request("/api/config/settings", "POST", {
            "settings": {"auto_refresh_minutes": 60}
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["settings"]["auto_refresh_minutes"], 60)

        status, result = self.request("/api/config/provider", "POST", {"provider": None})
        self.assertEqual(status, 400)
        self.assertIn("object", result["error"])

    def test_provider_import_accepts_portable_documents_and_modes(self):
        provider = {
            "schemaVersion": 4,
            "id": "portable-one",
            "name": "Portable One",
            "type": "page",
            "targetUrl": "https://one.example.test",
            "mode": "page",
            "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
        }
        status, result = self.request("/api/config/providers", "POST", provider)
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in result["configs"]], ["portable-one"])

        status, result = self.request("/api/config/providers", "POST", {
            "importMode": "merge",
            "providers": [{
                **provider,
                "id": "portable-two",
                "name": "Portable Two",
                "targetUrl": "https://two.example.test",
            }],
        })
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in result["configs"]], ["portable-one", "portable-two"])
        self.assertEqual(result["summary"]["added"], 1)

        status, result = self.request("/api/config/providers", "POST", [{
            **provider,
            "id": "portable-three",
            "name": "Portable Three",
            "targetUrl": "https://three.example.test",
        }])
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in result["configs"]], ["portable-three"])
        self.assertEqual(result["summary"]["removed"], 2)

    def test_static_pages_are_available(self):
        for path in ("/", "/channels", "/settings", "/static/app.css", "/static/api.js"):
            response = urlopen(self.base_url + path, timeout=3)
            self.assertEqual(response.status, 200)
            self.assertTrue(response.read())

        settings = urlopen(self.base_url + "/settings", timeout=3).read().decode("utf-8")
        self.assertIn('id="import-dialog"', settings)
        self.assertIn('value="merge"', settings)
        self.assertIn('id="local-sync-token"', settings)
        self.assertIn('/static/config-events.js', settings)
        self.assertIn('/static/api.js', settings)

        status, health = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertEqual(health["service"], "provider-usage-hub")
        self.assertEqual(health["schemaVersion"], 4)

    def test_refresh_all_runs_in_background_and_reports_progress(self):
        refresh_started = threading.Event()
        release_refresh = threading.Event()

        def fake_refresh_all(progress=None, configs=None):
            config = configs[0]
            progress("started", config, None)
            refresh_started.set()
            release_refresh.wait(timeout=2)
            snapshot = {"id": config.id, "status": "ok", "error": None}
            progress("completed", config, snapshot)
            return [snapshot]

        self.server.RequestHandlerClass.manager.refresh_all = fake_refresh_all

        status, created = self.request("/api/refresh", "POST")
        self.assertEqual(status, 202)
        self.assertTrue(created["started"])
        self.assertTrue(refresh_started.wait(timeout=1))
        job_id = created["refresh"]["id"]

        status, progress = self.request("/api/refresh")
        self.assertEqual(status, 200)
        self.assertEqual(progress["refresh"]["status"], "running")
        self.assertEqual(progress["refresh"]["providers"][0]["status"], "refreshing")

        status, duplicate = self.request("/api/refresh", "POST")
        self.assertEqual(status, 200)
        self.assertFalse(duplicate["started"])
        self.assertEqual(duplicate["refresh"]["id"], job_id)

        release_refresh.set()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, progress = self.request("/api/refresh")
            if progress["refresh"]["status"] != "running":
                break
            time.sleep(0.01)

        self.assertEqual(progress["refresh"]["status"], "completed")
        self.assertEqual(progress["refresh"]["completed"], 1)
        self.assertEqual(progress["refresh"]["successCount"], 1)
        self.assertEqual(progress["refresh"]["failureCount"], 0)

    def test_refresh_retry_only_retries_failed_providers(self):
        calls = []

        def fake_refresh_all(progress=None, configs=None, cancel_event=None):
            calls.append([config.id for config in configs])
            for config in configs:
                progress("started", config, None)
                status = "error" if len(calls) == 1 and config.id == "deepseek" else "ok"
                progress("completed", config, {
                    "id": config.id,
                    "status": status,
                    "error": "测试失败" if status == "error" else None,
                })
            return []

        self.server.RequestHandlerClass.manager.refresh_all = fake_refresh_all
        status, result = self.request("/api/refresh", "POST")
        self.assertEqual(status, 202)

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, result = self.request("/api/refresh")
            if result["refresh"]["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(result["refresh"]["status"], "completed")
        self.assertEqual(result["refresh"]["failureCount"], 1)

        status, retry = self.request("/api/refresh/retry", "POST")
        self.assertEqual(status, 202)
        self.assertTrue(retry["started"])
        self.assertEqual(retry["refresh"]["source"], "retry")
        self.assertEqual(retry["refresh"]["total"], 1)
        self.assertEqual(retry["refresh"]["providers"][0]["id"], "deepseek")

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, retry = self.request("/api/refresh")
            if retry["refresh"]["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(retry["refresh"]["status"], "completed")
        self.assertEqual(retry["refresh"]["failureCount"], 0)
        self.assertEqual(calls, [["deepseek", "channel-test"], ["deepseek"]])

    def test_refresh_cancel_marks_unstarted_providers_cancelled(self):
        refresh_started = threading.Event()

        def fake_refresh_all(progress=None, configs=None, cancel_event=None):
            config = configs[0]
            progress("started", config, None)
            refresh_started.set()
            cancel_event.wait(timeout=2)
            progress("completed", config, {
                "id": config.id,
                "status": "cancelled",
                "error": "刷新已取消",
            })
            for config in configs[1:]:
                progress("completed", config, {
                    "id": config.id,
                    "status": "cancelled",
                    "error": "刷新已取消",
                })
            return []

        self.server.RequestHandlerClass.manager.refresh_all = fake_refresh_all
        status, created = self.request("/api/refresh", "POST")
        self.assertEqual(status, 202)
        self.assertTrue(refresh_started.wait(timeout=1))

        status, result = self.request("/api/refresh/cancel", "POST")
        self.assertEqual(status, 200)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["refresh"]["status"], "cancelling")

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, result = self.request("/api/refresh")
            if result["refresh"]["status"] == "cancelled":
                break
            time.sleep(0.01)
        self.assertEqual(result["refresh"]["status"], "cancelled")
        self.assertEqual(result["refresh"]["failureCount"], 0)
        self.assertEqual(result["refresh"]["cancelledCount"], 2)

    def test_channel_refresh_runs_as_persisted_cancellable_job(self):
        started = threading.Event()

        def fake_refresh_channels(progress=None, configs=None, cancel_event=None):
            config = configs[0]
            progress("started", config, None)
            started.set()
            cancel_event.wait(timeout=2)
            progress("completed", config, {
                "id": config.id,
                "status": "cancelled",
                "error": "刷新已取消",
            })
            return []

        self.server.RequestHandlerClass.manager.refresh_channels = fake_refresh_channels
        status, result = self.request("/api/refresh-channels", "POST")
        self.assertEqual(status, 202)
        self.assertTrue(result["started"])
        self.assertEqual(result["refresh"]["total"], 1)
        self.assertTrue(started.wait(timeout=1))

        status, result = self.request("/api/refresh-channels/cancel", "POST")
        self.assertEqual(status, 200)
        self.assertTrue(result["cancelled"])

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, result = self.request("/api/refresh-channels")
            if result["refresh"]["status"] == "cancelled":
                break
            time.sleep(0.01)
        self.assertEqual(result["refresh"]["status"], "cancelled")
        self.assertEqual(result["refresh"]["cancelledCount"], 1)

    def test_channel_refresh_retry_includes_monitor_only_failures(self):
        calls = []

        def fake_refresh_channels(progress=None, configs=None, cancel_event=None):
            calls.append([config.id for config in configs])
            for config in configs:
                progress("started", config, None)
                progress("completed", config, {
                    "id": config.id,
                    "type": config.type,
                    "status": "ok",
                    "channelError": "monitor unavailable" if len(calls) == 1 else None,
                    "channelsStale": False,
                })
            return []

        self.server.RequestHandlerClass.manager.refresh_channels = fake_refresh_channels
        status, result = self.request("/api/refresh-channels", "POST")
        self.assertEqual(status, 202)

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, result = self.request("/api/refresh-channels")
            if result["refresh"]["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(result["refresh"]["failureCount"], 1)

        status, retry = self.request("/api/refresh-channels/retry", "POST")
        self.assertEqual(status, 202)
        self.assertTrue(retry["started"])
        self.assertEqual(retry["refresh"]["total"], 1)

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            _, retry = self.request("/api/refresh-channels")
            if retry["refresh"]["status"] != "running":
                break
            time.sleep(0.01)
        self.assertEqual(retry["refresh"]["failureCount"], 0)
        self.assertEqual(calls, [["channel-test"], ["channel-test"]])

    def test_refresh_job_recovers_interrupted_state(self):
        job_file = Path(self.temporary.name) / "persisted-job.json"
        job_file.write_text(json.dumps({
            "id": "old-job",
            "status": "running",
            "providers": [],
        }), encoding="utf-8")
        manager = ProviderManager(configs=[], cache_file=Path(self.temporary.name) / "other-cache.json")
        jobs = RefreshJobManager(manager, job_file=job_file)
        current = jobs.current()
        self.assertEqual(current["status"], "interrupted")
        self.assertEqual(current["error"], "服务重启导致刷新任务中断")
        persisted = json.loads(job_file.read_text(encoding="utf-8"))
        self.assertEqual(persisted["status"], "interrupted")

    def test_refresh_endpoints_report_conflict_during_another_refresh(self):
        manager = self.server.RequestHandlerClass.manager
        started = threading.Event()
        release = threading.Event()

        def fake_refresh(config, browser=None):
            started.set()
            release.wait(timeout=2)
            return {"id": config.id, "status": "ok"}

        manager._refresh_config = fake_refresh
        thread = threading.Thread(target=manager.refresh, args=("channel-test",))
        thread.start()
        self.assertTrue(started.wait(timeout=1))
        try:
            status, result = self.request("/api/refresh-channels", "POST")
            self.assertEqual(status, 409)
            self.assertIn("provider:channel-test", result["error"])

            status, result = self.request("/api/refresh", "POST")
            self.assertEqual(status, 409)
            self.assertIn("provider:channel-test", result["error"])
        finally:
            release.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())

    def test_local_sync_requires_token_and_honors_revision(self):
        provider = {
            "schemaVersion": 4,
            "id": "sync-page",
            "name": "Sync Page",
            "group": "同步",
            "type": "page",
            "targetUrl": "https://sync.example/dashboard",
            "rechargeRatio": 1,
            "enabled": True,
            "refreshOnVisit": False,
            "secondaryUrls": [],
            "mode": "page",
            "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
        }
        document = {"schemaVersion": 4, "providers": [provider]}
        with patch("server.get_or_create_local_sync_token", return_value="sync-token"):
            status, result = self.request("/api/local-sync/config")
            self.assertEqual(status, 401)
            self.assertIn("token", result["error"])

            headers = {"X-Provider-Sync-Token": "sync-token"}
            status, result = self.request("/api/local-sync/config", headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(result["schemaVersion"], 4)
            revision = result["revision"]

            status, preview = self.request(
                "/api/local-sync/preview",
                "POST",
                {"document": document, "importMode": "merge"},
                headers,
            )
            self.assertEqual(status, 200)
            self.assertEqual(preview["revision"], revision)
            self.assertEqual(preview["summary"]["added"], 1)
            self.assertNotIn("sync-page", [config.id for config in self.server.RequestHandlerClass.store.snapshot()[0]])

            status, conflict = self.request(
                "/api/local-sync/apply",
                "POST",
                {
                    "document": document,
                    "importMode": "merge",
                    "expectedRevision": "outdated",
                },
                headers,
            )
            self.assertEqual(status, 409)
            self.assertIn("configuration changed", conflict["error"])

            status, applied = self.request(
                "/api/local-sync/apply",
                "POST",
                {
                    "document": document,
                    "importMode": "merge",
                    "expectedRevision": revision,
                },
                headers,
            )
            self.assertEqual(status, 200)
            self.assertEqual(applied["summary"]["added"], 1)
            status, current = self.request("/api/local-sync/config", headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(applied["revision"], current["revision"])

    def test_local_sync_auth_sessions_are_origin_scoped_and_secret(self):
        with (
            patch("server.load_provider_auth_session", return_value={}),
            patch("server.save_provider_auth_session", return_value=True) as save_session,
        ):
            status, result = self.request("/api/local-sync/auth", "POST", {
                "sessions": [{
                    "providerId": "channel-test",
                    "origin": "https://channel.example",
                    "userId": "user-42",
                    "username": "alice",
                    "authToken": "access-token",
                    "refreshToken": "refresh-token",
                    "expiresAt": "123456",
                    "generation": 3,
                    "updatedAt": "2026-08-05T10:00:00Z",
                }]
            })
        self.assertEqual(status, 200)
        self.assertEqual(result["synced"], 1)
        saved_config, saved_session = save_session.call_args.args
        self.assertEqual(saved_config.id, "channel-test")
        self.assertEqual(saved_session["authToken"], "access-token")
        self.assertEqual(saved_session["userId"], "user-42")
        self.assertEqual(saved_session["source"], "local_sync")

        status, result = self.request("/api/local-sync/auth", "POST", {
            "sessions": [{
                "providerId": "channel-test",
                "origin": "https://attacker.example",
                "authToken": "access-token",
            }]
        })
        self.assertEqual(status, 400)
        self.assertIn("origin", result["error"])

    def test_local_sync_auth_skips_stale_sessions(self):
        current = {
            "schemaVersion": 1,
            "providerId": "channel-test",
            "origin": "https://channel.example",
            "userId": "user-42",
            "username": "alice",
            "authToken": "current-access",
            "refreshToken": "current-refresh",
            "expiresAt": "999999",
            "source": "local_sync",
            "generation": 4,
            "updatedAt": "2026-08-05T10:02:00+00:00",
            "verifiedAt": "",
        }
        with (
            patch("server.load_provider_auth_session", return_value=current),
            patch("server.save_provider_auth_session") as save_session,
        ):
            status, result = self.request("/api/local-sync/auth", "POST", {
                "sessions": [{
                    **current,
                    "authToken": "stale-access",
                    "updatedAt": "2026-08-05T10:01:00Z",
                }]
            })
        self.assertEqual(status, 200)
        self.assertEqual(result["synced"], 0)
        self.assertEqual(result["stale"], 1)
        self.assertEqual(result["staleProviders"], ["channel-test"])
        save_session.assert_not_called()

    def test_local_sync_auth_returns_structured_account_mismatch(self):
        with (
            patch("server.load_provider_auth_session", return_value={}),
            patch(
                "server.save_provider_auth_session",
                side_effect=ProviderAuthSessionError(
                    "account_mismatch",
                    "Authentication session belongs to a different account",
                ),
            ),
        ):
            status, result = self.request("/api/local-sync/auth", "POST", {
                "sessions": [{
                    "providerId": "channel-test",
                    "origin": "https://channel.example",
                    "userId": "84",
                    "username": "bob",
                    "authToken": "bob-access",
                    "updatedAt": "2026-08-05T10:03:00Z",
                }]
            })
        self.assertEqual(status, 400)
        self.assertEqual(result["code"], "account_mismatch")
        self.assertIn("different account", result["error"])

    def test_sync_auth_reads_live_browseros_sessions_without_copying_profile(self):
        auth_result = {
            "available": True,
            "eligible": 1,
            "matched": 1,
            "synced": 1,
            "providers": ["channel-test"],
        }
        with patch(
            "server.sync_browseros_auth_sessions", return_value=auth_result
        ) as sync_sessions:
            status, result = self.request("/api/sync-auth", "POST")

        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "live_browseros")
        self.assertEqual(result["authSessions"], auth_result)
        synced_configs = sync_sessions.call_args.args[0]
        self.assertEqual([config.id for config in synced_configs], ["deepseek", "channel-test"])


if __name__ == "__main__":
    unittest.main()
