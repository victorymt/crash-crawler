import assert from "node:assert/strict";
import test from "node:test";

function sessionArea(store) {
  return {
    async get(key) { return { [key]: store[key] }; },
    async set(value) { Object.assign(store, value); }
  };
}

function snapshot(config) {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    checkedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    balances: [],
    usage: [],
    metrics: [],
    raw: {}
  };
}

test("refresh runner schedules resource steps dynamically and persists each result", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  globalThis.chrome = {
    storage: { session: sessionArea(store) },
    tabs: { async remove() {} }
  };

  try {
    const { runRefreshBatch } = await import(`../extension/src/background/refresh_runner.js?lanes=${Date.now()}`);
    const configs = [
      { id: "network", name: "Network", type: "test", resource: "network" },
      { id: "page-1", name: "Page 1", type: "test", resource: "page" },
      { id: "page-2", name: "Page 2", type: "test", resource: "page" },
      { id: "page-3", name: "Page 3", type: "test", resource: "page" }
    ];
    let pageStartedResolve;
    const pageStarted = new Promise((resolve) => { pageStartedResolve = resolve; });
    let activePages = 0;
    let maxActivePages = 0;
    const savedIds = [];

    const results = await runRefreshBatch({
      configs,
      previousSnapshots: {},
      context: { trigger: "test", tabPolicy: "allow-hidden-tabs" },
      networkConcurrency: 1,
      pageConcurrency: 2,
      async collect(config, _previous, context) {
        return context.runAttempt(`${config.id}-step`, config.resource, async () => {
          if (config.resource === "network") {
            // A static API-before-page barrier would deadlock this assertion.
            await Promise.race([
              pageStarted,
              new Promise((_, reject) => setTimeout(() => reject(new Error("page lane did not start")), 200))
            ]);
          } else {
            activePages += 1;
            maxActivePages = Math.max(maxActivePages, activePages);
            pageStartedResolve();
            await new Promise((resolve) => setTimeout(resolve, 20));
            activePages -= 1;
          }
          return snapshot(config);
        });
      },
      async saveSnapshot(value) {
        savedIds.push(value.id);
        return value;
      }
    });

    assert.equal(results.length, 4);
    assert.equal(maxActivePages, 2);
    assert.deepEqual(new Set(savedIds), new Set(configs.map((config) => config.id)));
    assert.equal(store.providerRefreshRun.state, "complete");
    assert.ok(Object.values(store.providerRefreshRun.providers).every((state) => state.state === "complete"));
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("refresh runner resumes incomplete jobs and cleans orphan tabs", async () => {
  const originalChrome = globalThis.chrome;
  const now = new Date().toISOString();
  const store = {
    providerRefreshRun: {
      runId: "resume-me",
      state: "running",
      trigger: "auto",
      tabPolicy: "reuse-open-tabs",
      startedAt: now,
      updatedAt: now,
      providers: {
        done: { state: "complete", createdTabId: null, snapshotStatus: "ok" },
        pending: { state: "running", createdTabId: 77, currentStep: "generic-page" }
      }
    }
  };
  const removedTabs = [];
  globalThis.chrome = {
    storage: { session: sessionArea(store) },
    tabs: { async remove(tabId) { removedTabs.push(tabId); } }
  };

  try {
    const { runRefreshBatch } = await import(`../extension/src/background/refresh_runner.js?resume=${Date.now()}`);
    const configs = [
      { id: "done", name: "Done", type: "test" },
      { id: "pending", name: "Pending", type: "test" }
    ];
    const doneSnapshot = snapshot(configs[0]);
    const collected = [];
    const results = await runRefreshBatch({
      configs,
      previousSnapshots: { done: doneSnapshot },
      context: { trigger: "auto", tabPolicy: "reuse-open-tabs" },
      async collect(config, _previous, context) {
        collected.push(config.id);
        return context.runAttempt("resume-network", "network", async () => snapshot(config));
      },
      async saveSnapshot(value) { return value; }
    });

    assert.deepEqual(collected, ["pending"]);
    assert.deepEqual(removedTabs, [77]);
    assert.equal(results.length, 2);
    assert.equal(store.providerRefreshRun.runId, "resume-me");
    assert.equal(store.providerRefreshRun.state, "complete");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("refresh runner replaces incompatible jobs and closes every orphan tab", async () => {
  const originalChrome = globalThis.chrome;
  const now = new Date().toISOString();
  const store = {
    providerRefreshRun: {
      runId: "stale-run",
      state: "running",
      trigger: "auto",
      tabPolicy: "reuse-open-tabs",
      startedAt: now,
      updatedAt: now,
      providers: {
        first: { state: "running", createdTabId: 91, currentStep: "generic-page" },
        second: { state: "pending", createdTabId: 92, currentStep: null }
      }
    }
  };
  const removedTabs = [];
  globalThis.chrome = {
    storage: { session: sessionArea(store) },
    tabs: { async remove(tabId) { removedTabs.push(tabId); } }
  };

  try {
    const { runRefreshBatch } = await import(`../extension/src/background/refresh_runner.js?replace=${Date.now()}`);
    const config = { id: "current", name: "Current", type: "test" };
    await runRefreshBatch({
      configs: [config],
      previousSnapshots: {},
      context: { trigger: "manual", tabPolicy: "allow-hidden-tabs" },
      async collect(_config, _previous, context) {
        return context.runAttempt("fresh-page", "page", async () => snapshot(config));
      },
      async saveSnapshot(value) { return value; }
    });

    assert.deepEqual(removedTabs, [91, 92]);
    assert.notEqual(store.providerRefreshRun.runId, "stale-run");
    assert.equal(store.providerRefreshRun.trigger, "manual");
    assert.equal(store.providerRefreshRun.tabPolicy, "allow-hidden-tabs");
    assert.equal(store.providerRefreshRun.state, "complete");
    assert.deepEqual(Object.keys(store.providerRefreshRun.providers), ["current"]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("refresh runner recovers recent worker jobs and abandons stale jobs safely", async () => {
  const originalChrome = globalThis.chrome;
  const store = {
    providerRefreshRun: {
      runId: "recent-run",
      state: "running",
      trigger: "auto",
      tabPolicy: "reuse-open-tabs",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providers: { current: { state: "pending", createdTabId: 101 } }
    }
  };
  const removedTabs = [];
  globalThis.chrome = {
    storage: { session: sessionArea(store) },
    tabs: { async remove(tabId) { removedTabs.push(tabId); } }
  };

  try {
    const { recoverRefreshRun } = await import(`../extension/src/background/refresh_runner.js?recover=${Date.now()}`);
    const resumed = [];
    const result = await recoverRefreshRun(async (context) => {
      resumed.push(context);
      return "resumed";
    });
    assert.equal(result, "resumed");
    assert.deepEqual(resumed, [{ trigger: "auto", tabPolicy: "reuse-open-tabs" }]);
    assert.deepEqual(removedTabs, []);

    store.providerRefreshRun = {
      ...store.providerRefreshRun,
      runId: "stale-run",
      updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      providers: {
        current: { state: "running", createdTabId: 102, leaseUntil: new Date().toISOString() },
        done: { state: "complete", createdTabId: null }
      }
    };
    await recoverRefreshRun(async () => {
      throw new Error("stale jobs must not restart collection");
    });

    assert.deepEqual(removedTabs, [102]);
    assert.equal(store.providerRefreshRun.state, "interrupted");
    assert.equal(store.providerRefreshRun.providers.current.createdTabId, null);
    assert.equal(store.providerRefreshRun.providers.current.leaseUntil, null);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
