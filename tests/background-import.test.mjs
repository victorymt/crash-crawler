import test from "node:test";

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
