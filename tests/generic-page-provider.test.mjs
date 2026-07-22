import assert from "node:assert/strict";
import test from "node:test";

test("generic page provider collects configured balance and quota rules", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const createdUrls = [];
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
    tabs: {
      async query() {
        return [];
      },
      async create({ url }) {
        currentUrl = url;
        createdUrls.push(url);
        return { id: createdUrls.length, status: "complete" };
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
        const isSubscription = currentUrl.includes("/subscriptions");
        return [{
          result: {
            title: isSubscription ? "Subscriptions" : "Dashboard",
            url: currentUrl,
            text: isSubscription
              ? "Subscriptions\n剩余 6天13小时 (2026/07/29 00:17)\n每周\n$50.15 / $50.00\n6天13小时 后重置"
              : "Dashboard\n账户余额\n$74.84",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?case=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "ezaiclub-generic",
    name: "EZAICLUB Generic",
    type: "page",
    targetUrl: "https://www.ezaiclub.com/dashboard",
    enabled: true,
    secondaryUrls: [{ label: "打开订阅页", url: "https://www.ezaiclub.com/subscriptions" }],
    parserRules: {
      loginHints: ["Login", "Sign in", "登录"],
      readyPattern: "账户余额|每周|后重置",
      balances: [
        { label: "余额", pattern: "^[$](\\d+(?:\\.\\d+)?)$", valueGroup: 1, currency: "USD", limit: 1 }
      ],
      quotas: [
        {
          label: "每周用量",
          pattern: "^[$](\\d+(?:\\.\\d+)?)\\s*/\\s*[$](\\d+(?:\\.\\d+)?)$",
          usedGroup: 1,
          limitGroup: 2,
          currency: "USD",
          resetPattern: "(.+?)\\s*后重置"
        }
      ],
      textMetrics: [
        { label: "到期时间", pattern: "剩余\\s*[^()]*\\(([^)]+)\\)", valueGroup: 1 }
      ]
    }
  });

  assert.ok(createdUrls.includes("https://www.ezaiclub.com/subscriptions"));
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.balances[0].value, "74.84");
  assert.equal(snapshot.usage[0].label, "每周用量");
  assert.equal(snapshot.usage[0].value, "$50.15 / $50.00");
  assert.equal(snapshot.usage[0].resetIn, "6天13小时");
  assert.equal(snapshot.metrics.some((item) => item.label === "到期时间" && item.value === "2026/07/29 00:17"), true);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
