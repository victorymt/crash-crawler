import json
import unittest
from pathlib import Path

from provider_definitions import (
    PROVIDER_CAPABILITY_API_ONLY,
    PROVIDER_CAPABILITY_AUTO_DETECT,
    PROVIDER_CAPABILITY_CHANNELS,
    PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH,
    default_provider_mode,
    provider_definition_documents,
    provider_definition_types,
    provider_supports_capability,
)
from providers import PROVIDER_TYPES, ProviderConfig, is_api_provider


class ProviderDefinitionTests(unittest.TestCase):
    def test_every_definition_has_one_provider_implementation(self):
        self.assertEqual(tuple(PROVIDER_TYPES), provider_definition_types())

        schema = json.loads(
            (Path(__file__).parent / "schemas" / "provider-config-v4.schema.json")
            .read_text(encoding="utf-8")
        )
        schema_types = tuple(schema["$defs"]["provider"]["properties"]["type"]["enum"])
        self.assertEqual(schema_types, provider_definition_types())

    def test_capabilities_describe_optional_provider_workflows(self):
        self.assertTrue(provider_supports_capability("ezaiclub", PROVIDER_CAPABILITY_CHANNELS))
        self.assertTrue(provider_supports_capability("sub2api", PROVIDER_CAPABILITY_CHANNELS))
        self.assertTrue(
            provider_supports_capability("sub2api", PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH)
        )
        self.assertTrue(provider_supports_capability("newapi", PROVIDER_CAPABILITY_AUTO_DETECT))
        self.assertFalse(provider_supports_capability("deepseek", PROVIDER_CAPABILITY_CHANNELS))
        self.assertFalse(provider_supports_capability("missing", PROVIDER_CAPABILITY_CHANNELS))

    def test_default_modes_are_definition_owned(self):
        self.assertEqual(default_provider_mode("opencode"), "http_then_page")
        self.assertEqual(default_provider_mode("deepseek"), "api")
        self.assertEqual(default_provider_mode("newapi"), "api_then_page")
        self.assertEqual(default_provider_mode("missing"), "page")

        deepseek = ProviderConfig.from_dict({
            "id": "deepseek",
            "name": "DeepSeek",
            "type": "deepseek",
            "targetUrl": "https://platform.deepseek.com/usage",
        })
        self.assertEqual(deepseek.mode, "api")
        self.assertTrue(is_api_provider(deepseek))
        self.assertTrue(
            provider_supports_capability("deepseek", PROVIDER_CAPABILITY_API_ONLY)
        )

        documents = provider_definition_documents()
        deepseek_definition = next(item for item in documents if item["type"] == "deepseek")
        self.assertEqual(deepseek_definition["defaultMode"], "api")
        self.assertIn(PROVIDER_CAPABILITY_API_ONLY, deepseek_definition["capabilities"])


if __name__ == "__main__":
    unittest.main()
