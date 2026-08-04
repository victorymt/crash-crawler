import json
import tempfile
import unittest
from pathlib import Path

from providers import ProviderConfig
from web_store import ConfigStore, providers_from_import_document, validate_provider


class ConfigStoreTests(unittest.TestCase):
    def test_portable_provider_contract_fixtures_match_python(self):
        fixture = json.loads(
            (Path(__file__).parent / "tests/fixtures/provider-config-contract.json").read_text(encoding="utf-8")
        )
        for example in fixture["valid"]:
            with self.subTest(example=example["name"]):
                config = ProviderConfig.from_dict(example["input"])
                validate_provider(config)
                self.assertEqual(config.to_portable_dict(), example["expected"])
        for example in fixture["invalid"]:
            with self.subTest(example=example["name"]):
                with self.assertRaises(ValueError):
                    validate_provider(ProviderConfig.from_dict(example["input"]))

    def test_import_document_accepts_all_portable_wrappers(self):
        provider = {"id": "one"}
        self.assertEqual(providers_from_import_document(provider), [provider])
        self.assertEqual(providers_from_import_document([provider]), [provider])
        self.assertEqual(
            providers_from_import_document({"schemaVersion": 4, "providers": [provider]}),
            [provider],
        )
        with self.assertRaisesRegex(ValueError, "providers"):
            providers_from_import_document({"schemaVersion": 4})

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

    def test_store_accepts_extension_provider_with_empty_optional_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "schemaVersion": 4,
                "id": "page-provider-11",
                "name": "帅api",
                "type": "page",
                "targetUrl": "https://api.shuaiapi.com/dashboard/overview",
                "mode": "page",
                "parserRules": {
                    "loginHints": ["登录"],
                    "readySelector": "",
                    "balances": [],
                    "quotas": [],
                    "textMetrics": [],
                },
            }]}), encoding="utf-8")
            [config], _ = ConfigStore(path).snapshot()
            self.assertEqual(config.id, "page-provider-11")
            self.assertEqual(config.parser_rules["readySelector"], "")

    def test_store_reports_missing_provider_fields_as_value_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{"name": "Broken"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "id is required"):
                ConfigStore(path)

    def test_import_modes_merge_replace_and_report_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "id": "existing",
                "name": "Existing",
                "type": "page",
                "targetUrl": "https://existing.example.test",
                "refreshOnVisit": True,
                "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
            }]}), encoding="utf-8")
            store = ConfigStore(path)
            configs, summary = store.import_configs([{
                "id": "new",
                "name": "New",
                "type": "page",
                "targetUrl": "https://new.example.test",
                "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
            }], mode="merge")
            self.assertEqual([config.id for config in configs], ["existing", "new"])
            self.assertEqual(summary, {
                "added": 1, "updated": 0, "unchanged": 0, "removed": 0, "total": 2,
            })

            configs, summary = store.import_configs([{
                "id": "new",
                "name": "New updated",
                "type": "page",
                "targetUrl": "https://new.example.test",
                "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
            }], mode="replace")
            self.assertEqual([config.id for config in configs], ["new"])
            self.assertEqual(summary["updated"], 1)
            self.assertEqual(summary["removed"], 1)

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

    def test_import_rejects_unknown_v4_portable_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps({"providers": [{
                "id": "existing",
                "name": "Existing",
                "type": "page",
                "targetUrl": "https://existing.example.test",
                "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
            }]}), encoding="utf-8")
            store = ConfigStore(path)
            with self.assertRaisesRegex(ValueError, "unsupported fields"):
                store.import_configs([{
                    "schemaVersion": 4,
                    "id": "invalid",
                    "name": "Invalid",
                    "group": "",
                    "type": "page",
                    "targetUrl": "https://invalid.example.test",
                    "rechargeRatio": 1,
                    "enabled": True,
                    "refreshOnVisit": False,
                    "secondaryUrls": [],
                    "mode": "page",
                    "parserRules": {"balances": [], "quotas": [], "textMetrics": []},
                    "unexpected": True,
                }])


if __name__ == "__main__":
    unittest.main()
