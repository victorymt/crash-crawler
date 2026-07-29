import assert from "node:assert/strict";
import test from "node:test";

test("automatic selector collection requires a visit instead of creating a hidden tab", async () => {
  const originalChrome = globalThis.chrome;
  let createdTabs = 0;

  globalThis.chrome = {
    permissions: { async contains() { return true; } },
    tabs: {
      async query() { return []; },
      async create() {
        createdTabs += 1;
        throw new Error("automatic refresh must not create a tab");
      }
    },
    scripting: { async executeScript() { return []; } }
  };

  try {
    const { collectProvider } = await import(`../extension/src/providers/index.js?auto-policy=${Date.now()}`);
    await assert.rejects(
      () => collectProvider({
        id: "visit-required",
        name: "Visit Required",
        type: "page",
        targetUrl: "https://example.test/dashboard",
        enabled: true,
        secondaryUrls: [],
        parserRules: {
          balances: [{ id: "balance", label: "余额", selector: ".balance" }],
          quotas: [],
          textMetrics: []
        }
      }, {
        trigger: "auto",
        tabPolicy: "reuse-open-tabs"
      }),
      (error) => {
        assert.equal(error.code, "NEEDS_VISIT");
        assert.equal(error.collection.attempts.at(-1).errorCode, "NEEDS_VISIT");
        return true;
      }
    );
    assert.equal(createdTabs, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
