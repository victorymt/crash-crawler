import json
import tempfile
import unittest
from pathlib import Path

from web_store import ConfigStore


class ConfigStoreTests(unittest.TestCase):
    def test_store_accepts_extension_config_and_persists_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({
                "providers": [{
                    "id": "fastaitoken",
                    "name": "FastAIToken",
                    "type": "sub2api",
                    "targetUrl": "https://www.fastaitoken.com/dashboard",
                    "group": "常用",
                    "rechargeRatio": 2,
                }]
            }), encoding="utf-8")
            store = ConfigStore(path)
            configs, settings = store.snapshot()
            self.assertEqual(configs[0].recharge_ratio, 2)
            self.assertEqual(settings["auto_refresh_minutes"], 0)

            store.upsert({
                "id": "deepseek",
                "name": "DeepSeek",
                "type": "deepseek",
                "target_url": "https://platform.deepseek.com/usage",
            })
            store.replace([config.to_dict() for config in reversed(store.snapshot()[0])])
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in saved["providers"]], ["deepseek", "fastaitoken"])

    def test_store_rejects_unsupported_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "id": "bad",
                "name": "Bad",
                "type": "unknown",
                "target_url": "https://example.test",
            }]}), encoding="utf-8")
            with self.assertRaises(ValueError):
                ConfigStore(path)

    def test_store_accepts_generic_page_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "id": "custom-page",
                "name": "Custom Page",
                "type": "page",
                "targetUrl": "https://example.test/dashboard",
                "secondaryUrls": [{"id": "usage", "label": "Usage", "url": "https://example.test/usage"}],
                "parserRules": {
                    "balances": [{"id": "balance-1", "pageId": "main", "selector": ".balance"}],
                    "textMetrics": [{"id": "usage-1", "pageId": "usage", "selector": ".usage"}],
                },
            }]}), encoding="utf-8")
            [config], _ = ConfigStore(path).snapshot()
            self.assertEqual(config.type, "page")
            self.assertEqual(config.secondary_urls[0]["id"], "usage")

    def test_store_reports_missing_provider_fields_as_value_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{"name": "Broken"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "id is required"):
                ConfigStore(path)

    def test_store_rejects_unsafe_page_regex(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "id": "unsafe",
                "name": "Unsafe",
                "type": "page",
                "targetUrl": "https://example.test",
                "parserRules": {"balances": [{
                    "id": "balance-1", "pattern": "(a+)+$",
                }]},
            }]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unsafe repetition"):
                ConfigStore(path)


if __name__ == "__main__":
    unittest.main()
