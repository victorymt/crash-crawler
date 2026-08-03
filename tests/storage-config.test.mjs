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
  assert.equal(imported.schemaVersion, 4);
  assert.equal(imported.rechargeRatio, 1);
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
  assert.equal(protectedConfigs.find((item) => item.id === "opencode-go").refreshOnVisit, true);
  assert.equal(protectedConfigs.some((item) => item.id === "ezaiclub"), true);
  assert.equal(protectedConfigs.find((item) => item.id === "ezaiclub").rechargeRatio, 10);

  globalThis.chrome = originalChrome;
});

test("New API provider configs apply the built-in template", async () => {
  const { normalizeProviderConfig } = await import(`../extension/src/shared/config.js?newapi=${Date.now()}`);
  const config = normalizeProviderConfig({
    id: "newapi-site",
    name: "New API Site",
    template: "newapi",
    targetUrl: "https://api.example.test"
  });

  assert.equal(config.type, "newapi");
  assert.equal(config.mode, "api_then_page");
  assert.equal(config.targetUrl, "https://api.example.test/dashboard");
  assert.equal(config.secondaryUrls[0].url, "https://api.example.test/subscriptions");
  assert.equal(config.parserRules.balances[0].id, "newapi-balance");
  const migrated = normalizeProviderConfig({
    id: "old-newapi-site",
    name: "Old New API Site",
    type: "newapi",
    targetUrl: "https://api.example.test/dashboard",
    parserRules: {
      loginHints: ["New API", "API Key", "令牌"],
      balances: [{ id: "newapi-balance", label: "剩余额度", pattern: "余额 (\\d+)" }]
    }
  });
  assert.equal(migrated.parserRules.loginHints.includes("API Key"), false);
  assert.equal(migrated.parserRules.loginHints.includes("令牌"), false);
});

test("Sub2API provider configs apply the built-in template", async () => {
  const { normalizeProviderConfig } = await import(`../extension/src/shared/config.js?sub2api=${Date.now()}`);
  const config = normalizeProviderConfig({
    id: "aihub",
    name: "AIHub",
    template: "aihub",
    targetUrl: "https://aihub.top/"
  });

  assert.equal(config.type, "sub2api");
  assert.equal(config.mode, "api_then_page");
  assert.equal(config.targetUrl, "https://aihub.top/dashboard");
  assert.equal(config.secondaryUrls[0].url, "https://aihub.top/subscriptions");
  assert.equal(config.parserRules.balances[0].id, "sub2api-balance");
});

test("provider configs migrate and validate recharge ratios", async () => {
  const { normalizeProviderConfig } = await import(`../extension/src/shared/config.js?recharge=${Date.now()}`);
  const ezai = normalizeProviderConfig({
    id: "ezaiclub-old",
    name: "EZAIClub old config",
    type: "ezaiclub",
    targetUrl: "https://www.ezaiclub.com/dashboard"
  });
  const generic = normalizeProviderConfig({
    id: "generic",
    name: "Generic",
    type: "page",
    targetUrl: "https://example.test"
  });
  const custom = normalizeProviderConfig({ ...generic, rechargeRatio: "12.5" });

  assert.equal(ezai.schemaVersion, 4);
  assert.equal(ezai.rechargeRatio, 10);
  assert.equal(generic.rechargeRatio, 1);
  assert.equal(custom.rechargeRatio, 12.5);
  assert.throws(() => normalizeProviderConfig({ ...generic, rechargeRatio: 0 }), /rechargeRatio/);
  assert.throws(() => normalizeProviderConfig({ ...generic, rechargeRatio: 1001 }), /rechargeRatio/);
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

test("storage preserves provider groups and the complete provider order", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: { local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
        return { [key]: store[key] };
      },
      async set(value) { Object.assign(store, value); }
    } }
  };
  const { getProviderConfigs, saveProviderConfigs } = await import(`../extension/src/shared/storage.js?order=${Date.now()}`);
  const defaults = await getProviderConfigs();
  const custom = {
    id: "relay",
    name: "Relay",
    group: "低倍率",
    type: "page",
    targetUrl: "https://relay.example.test"
  };
  const requested = [custom, ...defaults.slice().reverse()];
  await saveProviderConfigs(requested);
  const saved = await getProviderConfigs();

  assert.deepEqual(saved.map((provider) => provider.id), requested.map((provider) => provider.id));
  assert.equal(saved[0].group, "低倍率");
  assert.equal(saved.find((provider) => provider.id === "deepseek").group, "");
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
  assert.equal(normalizeExtensionSettings({}).autoRefreshTabPolicy, "reuse-open-tabs");
  assert.equal(normalizeExtensionSettings({ autoRefreshTabPolicy: "api-only" }).autoRefreshTabPolicy, "api-only");
  assert.equal(normalizeExtensionSettings({ autoRefreshTabPolicy: "invalid" }).autoRefreshTabPolicy, "reuse-open-tabs");
  assert.equal(normalizeExtensionSettings({ preferredChannelModel: "gpt-5.6-sol" }).preferredChannelModel, "gpt-5.6-sol");
  assert.equal((await getExtensionSettings()).autoRefreshMinutes, 30);

  const saved = await saveExtensionSettings({ autoRefreshMinutes: 60, autoRefreshTabPolicy: "allow-hidden-tabs" });
  assert.equal(saved.autoRefreshMinutes, 60);
  assert.equal(saved.autoRefreshTabPolicy, "allow-hidden-tabs");
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
