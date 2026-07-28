import assert from "node:assert/strict";
import test from "node:test";

test("siliconflow wallet amount conversion and API mapping", async () => {
  const {
    siliconflowAmountToYuan,
    parseSiliconflowWalletName,
    parseSiliconflowWalletsApi,
    parseSiliconflowProfileApi,
    siliconflowApiSnapshot
  } = await import(`../extension/src/shared/parsers.js?sf-api=${Date.now()}`);

  assert.equal(siliconflowAmountToYuan(15951504400000), 15.9515044);
  assert.equal(siliconflowAmountToYuan("5.8912"), 5.8912);
  assert.equal(
    parseSiliconflowWalletName("{\"en-us\":\"Gift\",\"zh-cn\":\"认证奖励券\"}"),
    "认证奖励券"
  );

  const coupons = parseSiliconflowWalletsApi({
    code: 20000,
    data: {
      wallets: [{
        walletId: "W1",
        name: "{\"zh-cn\":\"认证奖励券\",\"en-us\":\"Gift\"}",
        balance: 15951504400000,
        stage: 3,
        expiresAt: 1797177600000
      }]
    }
  }, { stage: 3 });
  assert.equal(coupons.balances[0].value, "15.95");
  assert.equal(coupons.balances[0].label, "认证奖励券剩余额度");
  assert.equal(coupons.metrics.some((item) => item.label.includes("有效期")), true);

  const profile = parseSiliconflowProfileApi({
    data: { chargeBalance: "5", balance: "5.8912", totalBalance: "10.8912", creditLimit: "0" }
  });
  assert.equal(profile.balances.find((item) => item.key === "balance").value, "5.00");
  assert.equal(profile.balances.find((item) => item.key === "gift_balance").value, "5.89");

  const snapshot = siliconflowApiSnapshot(
    { id: "siliconflow", name: "SiliconFlow", type: "siliconflow", targetUrl: "https://cloud.siliconflow.cn/me/expensebill" },
    { data: { chargeBalance: "5", balance: "1.5", totalBalance: "6.5" } },
    { code: 20000, data: { wallets: [] } },
    {
      code: 20000,
      data: {
        wallets: [{
          name: "{\"zh-cn\":\"模型服务代金券\"}",
          balance: 5893077000000,
          stage: 3,
          expiresAt: 4102416000000
        }]
      }
    }
  );
  assert.equal(snapshot.raw.source, "api");
  assert.ok(snapshot.balances.some((item) => item.label === "余额" && item.value === "5.00"));
  assert.ok(snapshot.balances.some((item) => item.label.includes("代金券") && item.value === "5.89"));
  assert.ok(snapshot.metrics.some((item) => item.label === "代金券" && item.value === "1 张可用"));
});

test("SiliconFlow prefers API collection when subject id is available", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const fetchUrls = [];
  let createdTabs = 0;

  globalThis.fetch = async (url, options = {}) => {
    fetchUrls.push(String(url));
    const subject = options.headers?.["x-subject-id"] || options.headers?.["X-Subject-Id"];
    if (subject !== "subj-test-001") {
      return { ok: false, status: 400, async json() { return { code: 10001, message: "invalid SubjectId" }; } };
    }
    if (String(url).includes("profile/peek")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 20000, data: { chargeBalance: "8.5", balance: "2.25", totalBalance: "10.75", creditLimit: "0" } };
        }
      };
    }
    if (String(url).includes("stage=1")) {
      return { ok: true, status: 200, async json() { return { code: 20000, data: { wallets: [] } }; } };
    }
    if (String(url).includes("stage=3")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 20000,
            data: {
              wallets: [{
                name: "{\"zh-cn\":\"认证奖励券\"}",
                balance: 16000000000000,
                stage: 3,
                expiresAt: 1797177600000
              }]
            }
          };
        }
      };
    }
    return { ok: true, status: 200, url, async text() { return "<html></html>"; } };
  };

  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 3, url: "https://cloud.siliconflow.cn/me/expensebill?tab=coupon" }];
      },
      async create() {
        createdTabs += 1;
        throw new Error("API path should not open a new tab when subject id is on an open tab");
      },
      async get() { return { id: 3, status: "complete" }; },
      async remove() {},
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ args }) {
        if (Array.isArray(args) && args[0] === "sf-subject-id") {
          return [{ result: "subj-test-001" }];
        }
        throw new Error("DOM scrape should not run when SiliconFlow API succeeds");
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?sf-api-collect=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "siliconflow",
    name: "SiliconFlow",
    type: "siliconflow",
    targetUrl: "https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
    enabled: true,
    secondaryUrls: [],
    mode: "page"
  });

  assert.equal(createdTabs, 0);
  assert.equal(snapshot.raw.source, "api");
  assert.equal(snapshot.balances.find((item) => item.label === "余额").value, "8.50");
  assert.ok(snapshot.balances.some((item) => item.label.includes("认证奖励券")));
  assert.ok(fetchUrls.some((url) => url.includes("/walletd-server/api/v1/subject/profile/peek")));
  assert.ok(fetchUrls.some((url) => url.includes("stage=3")));

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
