import assert from "node:assert/strict";
import test from "node:test";

test("provider definitions own stable type order and default modes", async () => {
  const definitions = await import(
    `../extension/src/shared/provider_definitions.js?definitions=${Date.now()}`
  );
  const config = await import(`../extension/src/shared/config.js?definitions=${Date.now()}`);

  assert.deepEqual(definitions.providerDefinitionTypes(), [
    "page",
    "opencode",
    "deepseek",
    "ezaiclub",
    "siliconflow",
    "newapi",
    "sub2api"
  ]);
  assert.deepEqual(config.SUPPORTED_PROVIDER_TYPES, definitions.providerDefinitionTypes());
  assert.equal(definitions.defaultProviderMode("opencode"), "http_then_page");
  assert.equal(definitions.defaultProviderMode("deepseek"), "api");
  assert.equal(definitions.defaultProviderMode("newapi"), "api_then_page");
  assert.equal(definitions.defaultProviderMode("missing"), "page");
  assert.equal(Object.isFrozen(definitions.PROVIDER_DEFINITIONS), true);
});

test("provider definitions expose optional workflows as capabilities", async () => {
  const {
    PROVIDER_CAPABILITIES,
    providerSupportsCapability
  } = await import(`../extension/src/shared/provider_definitions.js?capabilities=${Date.now()}`);

  assert.equal(providerSupportsCapability("ezaiclub", PROVIDER_CAPABILITIES.CHANNELS), true);
  assert.equal(providerSupportsCapability("sub2api", PROVIDER_CAPABILITIES.CHANNELS), true);
  assert.equal(
    providerSupportsCapability("sub2api", PROVIDER_CAPABILITIES.LOCAL_SYNC_AUTH),
    true
  );
  assert.equal(providerSupportsCapability("newapi", PROVIDER_CAPABILITIES.AUTO_DETECT), true);
  assert.equal(providerSupportsCapability("deepseek", PROVIDER_CAPABILITIES.API_ONLY), true);
  assert.equal(providerSupportsCapability("deepseek", PROVIDER_CAPABILITIES.CHANNELS), false);
  assert.equal(providerSupportsCapability("missing", PROVIDER_CAPABILITIES.CHANNELS), false);
});
