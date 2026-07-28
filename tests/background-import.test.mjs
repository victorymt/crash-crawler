import test from "node:test";
import assert from "node:assert/strict";

test("background service worker imports with a mocked chrome API", async () => {
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    alarms: {
      async clear() { return true; },
      async create() {},
      onAlarm: { addListener() {} }
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {}
      }
    },
    tabs: {
      async query() {
        return [];
      }
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };
  await import("../extension/src/background/service_worker.js");
  delete globalThis.chrome;
});

test("background supports provider source import export and test messages", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const store = {};
  let messageListener = null;
  let currentUrl = "";

  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    url,
    async text() {
      return "<!doctype html><div id=\"root\"></div>";
    }
  });

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    alarms: {
      async clear() { return true; },
      async create() {},
      onAlarm: { addListener() {} }
    },
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
    },
    tabs: {
      async query() {
        return [];
      },
      async create({ url }) {
        currentUrl = url;
        return { id: 1, status: "complete" };
      },
      async update(_tabId, { url }) {
        currentUrl = url;
        return { id: 1, status: "complete" };
      },
      async get(tabId) {
        return { id: tabId, status: "complete" };
      },
      async remove() {},
      onUpdated: {
        addListener() {},
        removeListener() {}
      }
    },
    scripting: {
      async executeScript() {
        return [{
          result: {
            title: "Provider",
            url: currentUrl,
            text: "账户余额\n$10.00",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  await import(`../extension/src/background/service_worker.js?case=${Date.now()}`);
  const send = (message) => new Promise((resolve) => {
    messageListener(message, {}, resolve);
  });
  const provider = {
    id: "generic",
    name: "Generic",
    type: "page",
    targetUrl: "https://example.test",
    parserRules: {
      readyPattern: "账户余额|[$]\\d",
      balances: [{ label: "余额", pattern: "^[$](\\d+(?:\\.\\d+)?)$", valueGroup: 1, currency: "USD" }]
    }
  };

  assert.equal((await send({ type: "config:importProvider", provider })).ok, true);
  assert.equal((await send({ type: "config:exportProvider", providerId: "generic" })).provider.name, "Generic");
  const tested = await send({ type: "providers:test", providerId: "generic" });
  assert.equal(tested.provider.balances[0].value, "10.00");
  assert.equal(store.providerSnapshots, undefined);
  const moved = await send({
    type: "config:saveProvider",
    provider: { ...provider, targetUrl: "https://other.test/dashboard" }
  });
  assert.equal(moved.ok, true);
  const savedBuiltin = await send({
    type: "config:saveProvider",
    provider: {
      id: "opencode-go",
      name: "OpenCode Custom",
      type: "page",
      targetUrl: "https://opencode.ai/workspace/wrk_x/go",
      enabled: true
    }
  });
  assert.equal(savedBuiltin.ok, true);
  assert.equal(savedBuiltin.provider.type, "opencode");
  assert.equal(savedBuiltin.provider.targetUrl, "https://opencode.ai/workspace/wrk_x/go");
  await send({ type: "secret:setDeepSeekKey", value: "sk-test" });
  assert.equal(store.secrets.deepseekApiKey, "sk-test");
  await send({ type: "secret:clearDeepSeekKey" });
  assert.equal(store.secrets.deepseekApiKey, undefined);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test("background refreshAll runs providers concurrently and preserves all snapshots", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const store = {};
  let messageListener = null;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.deepseek.com")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "1.00", granted_balance: "0", topped_up_balance: "1.00" }]
          };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      async text() {
        return "<html>余额 $1.00</html>";
      }
    };
  };

  let badgeText = null;
  let snapshotWriteCount = 0;
  let alarmCreates = [];
  let alarmClears = [];
  let alarmListener = null;
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    action: {
      async setBadgeText({ text }) { badgeText = text; },
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    alarms: {
      async clear(name) {
        alarmClears.push(name);
        return true;
      },
      async create(name, info) {
        alarmCreates.push({ name, info });
      },
      onAlarm: {
        addListener(listener) { alarmListener = listener; }
      }
    },
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
          if (typeof key === "object" && key) {
            return Object.fromEntries(Object.keys(key).map((item) => [item, store[item]]));
          }
          return { [key]: store[key] };
        },
        async set(value) {
          if (Object.prototype.hasOwnProperty.call(value, "providerSnapshots")) {
            snapshotWriteCount += 1;
          }
          Object.assign(store, value);
        }
      }
    },
    tabs: {
      async query() { return []; },
      async create({ url }) { return { id: 1, url, status: "complete" }; },
      async update() { return { id: 1, status: "complete" }; },
      async get(tabId) { return { id: tabId, status: "complete" }; },
      async remove() {},
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ args }) {
        if (Array.isArray(args) && (args[0] === "auth_token" || args[0] === "sf-subject-id")) {
          return [{ result: "" }];
        }
        return [{
          result: {
            title: "Page",
            url: "https://example.test",
            text: "余额 $1.00",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  await import(`../extension/src/background/service_worker.js?refreshAll=${Date.now()}`);
  const send = (message) => new Promise((resolve) => {
    messageListener(message, {}, resolve);
  });

  const { DEFAULT_PROVIDER_CONFIGS } = await import(`../extension/src/shared/config.js?refreshAll=${Date.now()}`);

  store.providerConfigs = DEFAULT_PROVIDER_CONFIGS.map((config) => ({
    ...config,
    enabled: config.id === "deepseek" || config.id === "opencode-go" || config.id === "siliconflow"
  }));
  store.secrets = { deepseekApiKey: "sk-test" };

  const result = await send({ type: "providers:refreshAll" });
  assert.equal(result.ok, true);
  assert.equal(result.providers.length, 3);
  assert.equal(Object.keys(store.providerSnapshots || {}).length, 3);
  assert.ok(store.providerSnapshots.deepseek);
  assert.ok(store.providerSnapshots["opencode-go"] || store.providerSnapshots.siliconflow);
  // One batched snapshot write for refreshAll (not N per-provider writes).
  assert.equal(snapshotWriteCount, 1);
  assert.equal(typeof badgeText, "string");

  const saved = await send({ type: "settings:save", settings: { autoRefreshMinutes: 15 } });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.autoRefreshMinutes, 15);
  assert.equal(saved.alarm.enabled, true);
  assert.equal(saved.alarm.periodMinutes, 15);
  assert.ok(alarmCreates.some((item) => item.name === "providers:autoRefresh" && item.info.periodInMinutes === 15));

  const disabled = await send({ type: "settings:save", settings: { autoRefreshMinutes: 0 } });
  assert.equal(disabled.alarm.enabled, false);
  assert.ok(alarmClears.includes("providers:autoRefresh"));

  await send({ type: "settings:save", settings: { autoRefreshMinutes: 30 } });
  const beforeAlarmSnapshots = snapshotWriteCount;
  // Alarm handler is fire-and-forget; wait until refresh finishes writing.
  const alarmDone = new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (snapshotWriteCount > beforeAlarmSnapshots || Date.now() - started > 8000) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
  alarmListener({ name: "providers:autoRefresh" });
  await alarmDone;
  assert.ok(snapshotWriteCount > beforeAlarmSnapshots);
  assert.ok(store.extensionSettings?.lastAutoRefreshAt);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
