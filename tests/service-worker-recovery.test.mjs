import assert from "node:assert/strict";
import test from "node:test";

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

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for service worker recovery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("service worker resumes an interrupted auto refresh and records completion", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { DEFAULT_PROVIDER_CONFIGS } = await import("../extension/src/shared/config.js");
  const now = new Date().toISOString();
  const store = {
    providerConfigs: DEFAULT_PROVIDER_CONFIGS.map((config) => ({
      ...config,
      enabled: config.id === "deepseek"
    })),
    secrets: { deepseekApiKey: "sk-test" },
    extensionSettings: {
      autoRefreshMinutes: 30,
      autoRefreshTabPolicy: "api-only",
      lastAutoRefreshAt: null,
      lastAutoRefreshAttemptAt: now,
      lastAutoRefreshError: "previous interruption"
    },
    providerRefreshRun: {
      runId: "recover-auto",
      state: "running",
      trigger: "auto",
      tabPolicy: "api-only",
      startedAt: now,
      updatedAt: now,
      providers: {
        deepseek: { state: "running", createdTabId: null, currentStep: "deepseek-api" }
      }
    }
  };

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "8.00", granted_balance: "0", topped_up_balance: "8.00" }]
      };
    }
  });
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
      local: storageArea(store),
      session: storageArea(store)
    }
  };

  try {
    await import(`../extension/src/background/service_worker.js?autoRecovery=${Date.now()}`);
    await waitFor(() => store.providerRefreshRun?.state === "complete" && Boolean(store.extensionSettings?.lastAutoRefreshAt));

    assert.equal(store.providerRefreshRun.runId, "recover-auto");
    assert.equal(store.providerRefreshRun.providers.deepseek.state, "complete");
    assert.equal(store.providerSnapshots.deepseek.status, "ok");
    assert.equal(store.extensionSettings.lastAutoRefreshError, null);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
