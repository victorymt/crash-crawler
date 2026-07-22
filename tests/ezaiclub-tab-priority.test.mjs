import assert from "node:assert/strict";
import test from "node:test";

test("EZAICLUB prefers the dashboard tab for balance collection", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const tabById = new Map([
    [1, "https://www.ezaiclub.com/subscriptions"],
    [2, "https://www.ezaiclub.com/dashboard"]
  ]);

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
        return [
          { id: 1, url: "https://www.ezaiclub.com/subscriptions" },
          { id: 2, url: "https://www.ezaiclub.com/dashboard" }
        ];
      },
      async create() {
        throw new Error("rendered fallback should not be used when a matching dashboard tab exists");
      },
      async get() {
        return { id: 1, status: "complete" };
      },
      async remove() {},
      onUpdated: {
        addListener() {},
        removeListener() {}
      }
    },
    scripting: {
      async executeScript({ target }) {
        const url = tabById.get(target.tabId);
        return [{
          result: {
            title: url.includes("/subscriptions") ? "Subscriptions" : "Dashboard",
            url,
            text: url.includes("/subscriptions")
              ? "Subscriptions\n当前套餐\nPro Monthly\n到期时间\n2026-08-21"
              : "Dashboard\n账户余额\n¥ 88.60\n充值",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?case=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "ezaiclub",
    name: "EZAICLUB",
    type: "ezaiclub",
    targetUrl: "https://www.ezaiclub.com/dashboard",
    enabled: true,
    secondaryUrls: [{ label: "打开订阅页", url: "https://www.ezaiclub.com/subscriptions" }],
    mode: "page"
  });

  assert.equal(snapshot.balances[0].value, "88.60");
  assert.equal(snapshot.metrics.some((item) => item.label === "当前套餐"), true);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
