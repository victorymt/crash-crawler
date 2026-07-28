import assert from "node:assert/strict";
import test from "node:test";

test("parallel saveSnapshot writes do not drop snapshots", async () => {
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
          // Simulate slow storage to expose race conditions without a lock.
          await new Promise((resolve) => setTimeout(resolve, 15));
          Object.assign(store, value);
        }
      }
    }
  };

  const { saveSnapshot, getSnapshots } = await import(`../extension/src/shared/storage.js?lock=${Date.now()}`);
  await Promise.all([
    saveSnapshot({ id: "a", status: "ok", value: 1 }),
    saveSnapshot({ id: "b", status: "ok", value: 2 }),
    saveSnapshot({ id: "c", status: "ok", value: 3 })
  ]);

  const snapshots = await getSnapshots();
  assert.deepEqual(Object.keys(snapshots).sort(), ["a", "b", "c"]);
  assert.equal(snapshots.a.value, 1);
  assert.equal(snapshots.b.value, 2);
  assert.equal(snapshots.c.value, 3);

  globalThis.chrome = originalChrome;
});

test("storage mutations serialize delete with refresh and reject older snapshots", async () => {
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
          await new Promise((resolve) => setTimeout(resolve, 10));
          Object.assign(store, value);
        }
      }
    }
  };

  const {
    deleteProviderConfig,
    getSnapshots,
    importProviderConfig,
    saveSnapshot
  } = await import(`../extension/src/shared/storage.js?all-lock=${Date.now()}`);
  await importProviderConfig({
    id: "removed",
    name: "Removed",
    type: "page",
    targetUrl: "https://removed.test"
  });

  await Promise.all([
    saveSnapshot({ id: "removed", status: "ok", checkedAt: "2026-07-28T10:00:00.000Z" }),
    deleteProviderConfig("removed")
  ]);
  assert.equal((await getSnapshots()).removed, undefined);

  await saveSnapshot({ id: "kept", status: "ok", checkedAt: "2026-07-28T11:00:00.000Z", value: "new" });
  const saved = await saveSnapshot({ id: "kept", status: "ok", checkedAt: "2026-07-28T10:00:00.000Z", value: "old" });
  assert.equal(saved.value, "new");
  assert.equal((await getSnapshots()).kept.value, "new");

  globalThis.chrome = originalChrome;
});
