import assert from "node:assert/strict";
import test from "node:test";

test("SiliconFlow falls back to a rendered tab when static HTML has no balance fields", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let createdTab = false;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: "https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
    async text() {
      return "<!doctype html><div id=\"root\"></div>";
    }
  });

  globalThis.chrome = {
    tabs: {
      async query() {
        return [];
      },
      async create() {
        createdTab = true;
        return { id: 1, status: "complete" };
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
      async executeScript() {
        return [{
          result: {
            title: "SiliconFlow",
            url: "https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
            text: "费用账单\n可用余额\n¥ 23.50\n优惠券\n10.00 CNY",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?case=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "siliconflow",
    name: "SiliconFlow",
    type: "siliconflow",
    targetUrl: "https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
    enabled: true,
    secondaryUrls: [],
    mode: "page"
  });

  assert.equal(createdTab, true);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.balances[0].value, "23.50");

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
