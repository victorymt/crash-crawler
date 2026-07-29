import assert from "node:assert/strict";
import test from "node:test";

test("provider session hints are ephemeral, scoped and expire", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: store[key] }; },
        async set(value) { Object.assign(store, value); }
      }
    }
  };

  try {
    const {
      clearProviderSessionHints,
      getSessionHint,
      setSessionHint
    } = await import(`../extension/src/providers/session_cache.js?cache=${Date.now()}`);

    await setSessionHint("ezaiclub", "authToken", "secret-token", 60_000);
    assert.equal(await getSessionHint("ezaiclub", "authToken"), "secret-token");
    assert.equal(await getSessionHint("siliconflow", "authToken"), "");

    store.providerSessionHints.ezaiclub.authToken.expiresAt = Date.now() - 1;
    assert.equal(await getSessionHint("ezaiclub", "authToken"), "");
    assert.equal(store.providerSessionHints.ezaiclub, undefined);

    await setSessionHint("siliconflow", "subjectId", "subject-1", 60_000);
    assert.equal(await clearProviderSessionHints("siliconflow"), true);
    assert.equal(await getSessionHint("siliconflow", "subjectId"), "");
  } finally {
    globalThis.chrome = originalChrome;
  }
});
