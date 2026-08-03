import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from providers import ProviderManager
from server import DashboardHandler
from web_store import ConfigStore


class ServerApiTests(unittest.TestCase):
    def setUp(self):
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

    def request(self, path, method="GET", data=None):
        body = json.dumps(data).encode("utf-8") if data is not None else None
        request = Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            response = urlopen(request, timeout=3)
            return response.status, json.loads(response.read())
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_config_and_channel_endpoints(self):
        status, config = self.request("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in config["configs"]], ["deepseek", "channel-test"])

        status, channels = self.request("/api/channels?model=model-a")
        self.assertEqual(status, 200)
        self.assertEqual(channels["models"], ["model-a"])
        self.assertEqual(channels["channels"][0]["effectiveMultiplier"], 0.1)
        self.assertEqual(channels["summary"]["providerCount"], 1)
        self.assertEqual(channels["summary"]["latestCheckedAt"], "2026-08-03T12:00:00+08:00")

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

    def test_static_pages_are_available(self):
        for path in ("/", "/channels", "/settings", "/static/app.css"):
            response = urlopen(self.base_url + path, timeout=3)
            self.assertEqual(response.status, 200)
            self.assertTrue(response.read())


if __name__ == "__main__":
    unittest.main()
