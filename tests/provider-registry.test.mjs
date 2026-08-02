import assert from "node:assert/strict";
import test from "node:test";

test("provider registry validates adapters and preserves registration order", async () => {
  const { createProviderRegistry } = await import(`../extension/src/providers/registry.js?registry=${Date.now()}`);
  const registry = createProviderRegistry();
  registry.register("first", { async collect() { return "first"; } });
  registry.register("second", { async collect() { return "second"; } });

  assert.deepEqual(registry.types(), ["first", "second"]);
  assert.equal(await registry.get("second").collect(), "second");
  assert.equal(registry.get("missing"), null);
  assert.throws(() => registry.register("first", { collect() {} }), /already registered/);
  assert.throws(() => registry.register("invalid", {}), /must define collect/);
});

test("built-in provider adapters are registered through the public facade", async () => {
  const { providerAdapterTypes } = await import(`../extension/src/providers/index.js?adapter-types=${Date.now()}`);
  assert.deepEqual(providerAdapterTypes(), ["page", "opencode", "deepseek", "ezaiclub", "siliconflow", "newapi", "sub2api"]);
});
