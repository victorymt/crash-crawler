import assert from "node:assert/strict";
import test from "node:test";

function response(url, payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "application/json" },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); }
  };
}

function storageArea(store) {
  return {
    async get(key) {
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
      if (typeof key === "object" && key) {
        return Object.fromEntries(Object.keys(key).map((item) => [item, store[item]]));
      }
      return { [key]: store[key] };
    },
    async set(value) { Object.assign(store, value); }
  };
}

test("popup discovery adds a logged-in Sub2API site once and stores its first snapshot", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const store = {};
  const sessionStore = {};
  const requested = [];
  let messageListener = null;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    requested.push(parsed.href);
    if (parsed.hostname !== "relay.example.test") return response(url, { message: "not found" }, 404);
    if (parsed.pathname === "/api/user/self") return response(url, { message: "not found" }, 404);
    assert.equal(options.headers?.Authorization, "Bearer test-token");
    if (parsed.pathname === "/api/v1/auth/me") {
      return response(url, { data: { username: "alice", balance: 12.3 } });
    }
    if (parsed.pathname === "/api/v1/usage/dashboard/stats") {
      return response(url, { data: { total_requests: 9 } });
    }
    if (parsed.pathname === "/api/v1/channel-monitors") return response(url, { data: { items: [] } });
    if (parsed.pathname === "/api/v1/channels/available") return response(url, { data: [] });
    if (parsed.pathname === "/api/v1/groups/rates") return response(url, { data: {} });
    throw new Error(`unexpected URL: ${url}`);
  };

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
    permissions: { async contains() { return true; } },
    storage: {
      local: storageArea(store),
      session: storageArea(sessionStore)
    },
    tabs: {
      async query() {
        return [{ id: 7, url: "https://relay.example.test/providers", status: "complete" }];
      },
      async create({ url }) { return { id: 7, url, status: "complete" }; },
      async get(tabId) { return { id: tabId, url: "https://relay.example.test/providers", status: "complete" }; },
      async remove() {},
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ args }) {
        if (args?.[0] === "auth_token") return [{ result: "test-token" }];
        return [{ result: null }];
      }
    }
  };

  try {
    await import(`../extension/src/background/service_worker.js?discovery=${Date.now()}`);
    const send = (message) => new Promise((resolve) => messageListener(message, {}, resolve));
    const page = { url: "https://relay.example.test/providers", title: "供应商大厅 - Relay Hub" };
    const added = await send({ type: "providers:addCurrentPage", page });

    assert.equal(added.ok, true);
    assert.equal(added.added, true);
    assert.equal(added.detectedType, "sub2api");
    assert.equal(added.provider.id, "relay.example.test");
    assert.equal(added.provider.name, "Relay Hub");
    assert.equal(added.provider.type, "sub2api");
    assert.equal(added.provider.targetUrl, "https://relay.example.test/dashboard");
    assert.equal(added.provider.refreshOnVisit, true);
    assert.equal(store.providerSnapshots[added.provider.id].raw.source, "sub2api");
    assert.equal(store.providerSnapshots[added.provider.id].balances[0].value, "12.30");

    const requestCount = requested.length;
    const duplicate = await send({ type: "providers:addCurrentPage", page });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.upgraded, false);
    assert.equal(requested.length, requestCount);
    assert.equal(store.providerConfigs.filter((config) => config.id === "relay.example.test").length, 1);

    const storedProvider = store.providerConfigs.find((config) => config.id === "relay.example.test");
    storedProvider.type = "page";
    storedProvider.targetUrl = "https://relay.example.test/providers";
    storedProvider.rechargeRatio = 7;
    const upgraded = await send({ type: "providers:addCurrentPage", page });
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.added, false);
    assert.equal(upgraded.upgraded, true);
    assert.equal(upgraded.provider.id, "relay.example.test");
    assert.equal(upgraded.provider.type, "sub2api");
    assert.equal(upgraded.provider.targetUrl, "https://relay.example.test/dashboard");
    assert.equal(upgraded.provider.rechargeRatio, 7);

    const unsupported = await send({
      type: "providers:addCurrentPage",
      page: { url: "https://unsupported.example.test/", title: "Unsupported" }
    });
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error, /未识别/);
    assert.equal(store.providerConfigs.some((config) => config.id === "unsupported.example.test"), false);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
