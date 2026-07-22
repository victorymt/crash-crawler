import test from "node:test";
import assert from "node:assert/strict";

test("background service worker imports with a mocked chrome API", async () => {
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
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
      onMessage: { addListener(listener) { messageListener = listener; } }
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

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
