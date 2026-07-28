import assert from "node:assert/strict";
import test from "node:test";

test("storage imports and exports single provider sources", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
          return { [key]: store[key] };
        },
        async set(value) {
          Object.assign(store, value);
        }
      }
    }
  };

  const {
    exportProviderConfig,
    getProviderConfigs,
    importProviderConfig,
    saveProviderConfigs
  } = await import(`../extension/src/shared/storage.js?case=${Date.now()}`);

  await saveProviderConfigs([
    {
      id: "one",
      name: "One",
      type: "page",
      targetUrl: "https://example.test/one",
      enabled: true
    }
  ]);

  const imported = await importProviderConfig({
    schemaVersion: 1,
    id: "two",
    name: "Two",
    type: "page",
    targetUrl: "https://example.test/two",
    parserRules: { balances: [{ label: "余额", pattern: "balance" }] }
  });

  assert.equal(imported.id, "two");
  assert.equal(imported.schemaVersion, 2);
  assert.equal((await getProviderConfigs()).length, 6);
  assert.equal((await exportProviderConfig("two")).parserRules.balances[0].label, "余额");

  await importProviderConfig({
    id: "two",
    name: "Two Updated",
    type: "page",
    targetUrl: "https://example.test/two-updated"
  });
  const configs = await getProviderConfigs();
  assert.equal(configs.length, 6);
  assert.equal(configs.find((item) => item.id === "two").name, "Two Updated");
  await assert.rejects(() => importProviderConfig({
    id: "deepseek",
    name: "Replaced",
    type: "page",
    targetUrl: "https://example.test"
  }), /Built-in provider cannot be replaced/);

  await saveProviderConfigs([
    ...configs.filter((item) => item.id !== "ezaiclub").map((item) => item.id === "deepseek" ? {
      ...item,
      name: "Changed DeepSeek",
      type: "page",
      targetUrl: "https://example.test/replaced",
      enabled: false
    } : item)
  ]);
  const protectedConfigs = await getProviderConfigs();
  // Built-in type stays fixed; name/URL/enabled are user-editable.
  assert.equal(protectedConfigs.find((item) => item.id === "deepseek").name, "Changed DeepSeek");
  assert.equal(protectedConfigs.find((item) => item.id === "deepseek").type, "deepseek");
  assert.equal(protectedConfigs.find((item) => item.id === "deepseek").targetUrl, "https://example.test/replaced");
  assert.equal(protectedConfigs.find((item) => item.id === "deepseek").enabled, false);
  assert.equal(protectedConfigs.some((item) => item.id === "ezaiclub"), true);

  globalThis.chrome = originalChrome;
});

test("storage preserves builtin OpenCode workspace URL customizations", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
          return { [key]: store[key] };
        },
        async set(value) {
          Object.assign(store, value);
        }
      }
    }
  };

  const { getProviderConfigs, saveProviderConfig } = await import(`../extension/src/shared/storage.js?builtin=${Date.now()}`);
  const workspace = "https://opencode.ai/workspace/wrk_custom/go";
  const saved = await saveProviderConfig({
    id: "opencode-go",
    name: "My OpenCode",
    type: "page",
    targetUrl: workspace,
    enabled: true,
    secondaryUrls: []
  });
  assert.equal(saved.type, "opencode");
  assert.equal(saved.targetUrl, workspace);
  assert.equal(saved.name, "My OpenCode");
  const reloaded = (await getProviderConfigs()).find((item) => item.id === "opencode-go");
  assert.equal(reloaded.targetUrl, workspace);
  assert.equal(reloaded.type, "opencode");

  globalThis.chrome = originalChrome;
});

test("extension settings normalize auto-refresh intervals", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
          return { [key]: store[key] };
        },
        async set(value) {
          Object.assign(store, value);
        }
      }
    }
  };
  const {
    getExtensionSettings,
    normalizeExtensionSettings,
    saveExtensionSettings
  } = await import(`../extension/src/shared/storage.js?settings=${Date.now()}`);

  assert.equal(normalizeExtensionSettings({ autoRefreshMinutes: 7 }).autoRefreshMinutes, 30);
  assert.equal(normalizeExtensionSettings({ autoRefreshMinutes: 0 }).autoRefreshMinutes, 0);
  assert.equal((await getExtensionSettings()).autoRefreshMinutes, 30);

  const saved = await saveExtensionSettings({ autoRefreshMinutes: 60 });
  assert.equal(saved.autoRefreshMinutes, 60);
  assert.equal((await getExtensionSettings()).autoRefreshMinutes, 60);

  globalThis.chrome = originalChrome;
});

test("storage batch import is atomic and delete removes the matching snapshot", async () => {
  const originalChrome = globalThis.chrome;
  const store = { providerSnapshots: { kept: { id: "kept" }, removed: { id: "removed" } } };
  let setCalls = 0;
  globalThis.chrome = {
    storage: { local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
        return { [key]: store[key] };
      },
      async set(value) { setCalls += 1; Object.assign(store, value); }
    } }
  };
  const { deleteProviderConfig, importProviderConfigs } = await import(`../extension/src/shared/storage.js?batch=${Date.now()}`);
  const valid = (id) => ({ id, name: id, type: "page", targetUrl: `https://${id}.test` });

  const imported = await importProviderConfigs([valid("kept"), valid("removed")]);
  assert.deepEqual(imported.map((item) => item.id), ["kept", "removed"]);
  assert.equal(setCalls, 1);

  const beforeInvalid = JSON.stringify(store.providerConfigs);
  await assert.rejects(() => importProviderConfigs([valid("third"), { ...valid("bad"), targetUrl: "invalid" }]), /targetUrl is invalid/);
  assert.equal(JSON.stringify(store.providerConfigs), beforeInvalid);
  assert.equal(setCalls, 1);
  await assert.rejects(() => importProviderConfigs([valid("same"), valid("same")]), /Duplicate provider id/);
  assert.equal(setCalls, 1);

  await deleteProviderConfig("removed");
  assert.equal(setCalls, 2);
  assert.equal(store.providerConfigs.some((item) => item.id === "removed"), false);
  assert.equal(store.providerSnapshots.removed, undefined);
  assert.deepEqual(store.providerSnapshots.kept, { id: "kept" });
  globalThis.chrome = originalChrome;
});
