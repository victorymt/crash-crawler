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

test("local sync auth reads only open matching channel provider tabs", async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      async query({ url }) {
        assert.equal(url, "https://fluxionai.space/*");
        return [{ id: 42, url: "https://fluxionai.space/monitor" }];
      }
    },
    scripting: {
      async executeScript({ target }) {
        assert.equal(target.tabId, 42);
        return [{ result: {
          authToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: "123456",
          authUser: JSON.stringify({ id: "user-42", username: "alice" })
        } }];
      }
    }
  };
  const { collectLocalSyncAuthSessions } = await import(
    `../extension/src/providers/index.js?local-auth=${Date.now()}`
  );
  const sessions = await collectLocalSyncAuthSessions([
    {
      id: "fluxion",
      name: "FluxionAI",
      type: "sub2api",
      targetUrl: "https://fluxionai.space/dashboard"
    },
    {
      id: "page",
      name: "Page",
      type: "page",
      targetUrl: "https://page.example/dashboard"
    }
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].schemaVersion, 1);
  assert.equal(sessions[0].providerId, "fluxion");
  assert.equal(sessions[0].origin, "https://fluxionai.space");
  assert.equal(sessions[0].userId, "user-42");
  assert.equal(sessions[0].username, "alice");
  assert.equal(sessions[0].authToken, "access-token");
  assert.equal(sessions[0].refreshToken, "refresh-token");
  assert.equal(sessions[0].source, "browser_tab");
  assert.ok(sessions[0].updatedAt);
  globalThis.chrome = originalChrome;
});
