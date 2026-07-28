import assert from "node:assert/strict";
import test from "node:test";

test("EZAICLUB collects subscriptions from the rendered subscriptions page", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const createdUrls = [];
  let createCount = 0;
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
        createCount += 1;
        currentUrl = url;
        createdUrls.push(url);
        return { id: 1, status: "complete" };
      },
      async update(_tabId, { url }) {
        currentUrl = url;
        createdUrls.push(`update:${url}`);
        return { id: 1, status: "complete" };
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
      async executeScript({ args }) {
        // API path probes localStorage first; force fallback to DOM collectors.
        if (Array.isArray(args) && args[0] === "auth_token") {
          return [{ result: "" }];
        }
        const isSubscription = currentUrl.includes("/subscriptions");
        return [{
          result: {
            title: isSubscription ? "Subscriptions" : "Dashboard",
            url: currentUrl,
            text: isSubscription
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

  // Token probe may open one short-lived tab before the page-session collectors.
  assert.ok(createCount >= 1);
  assert.equal(createdUrls[0], "https://www.ezaiclub.com/dashboard");
  assert.ok(createdUrls.some((url) => url.includes("/subscriptions")));
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.balances[0].value, "88.60");
  assert.equal(snapshot.metrics.some((item) => item.label === "当前套餐" && item.value === "Pro Monthly"), true);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
