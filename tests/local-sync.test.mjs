import assert from "node:assert/strict";
import test from "node:test";

test("local sync settings stay on loopback and requests carry the token", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const store = {};
  globalThis.chrome = {
    storage: { local: {
      async get(key) { return { [key]: store[key] }; },
      async set(value) { Object.assign(store, value); }
    } },
    permissions: { async request() { return true; } }
  };
  const module = await import(`../extension/src/shared/local_sync.js?case=${Date.now()}`);
  assert.throws(
    () => module.normalizeLocalSyncSettings({ url: "https://example.com", token: "secret" }),
    /localhost|回环/
  );
  const settings = await module.saveLocalSyncSettings({ url: "http://127.0.0.1:19765/", token: "secret" });
  assert.equal(settings.url, "http://127.0.0.1:19765");

  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers["X-Provider-Sync-Token"], "secret");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const response = await module.localSyncRequest(settings, "/api/local-sync/config");
  assert.equal(response.ok, true);

  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
});
