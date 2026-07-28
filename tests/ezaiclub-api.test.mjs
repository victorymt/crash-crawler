import assert from "node:assert/strict";
import test from "node:test";

test("parseEzaiclubAuthMe and subscriptions API map balance and weekly quota", async () => {
  const {
    parseEzaiclubAuthMe,
    parseEzaiclubSubscriptionsApi,
    ezaiclubApiSnapshot
  } = await import(`../extension/src/shared/parsers.js?api=${Date.now()}`);

  const balances = parseEzaiclubAuthMe({
    code: 0,
    data: { balance: 26.60656112, frozen_balance: 0 }
  });
  assert.equal(balances[0].value, "26.61");
  assert.equal(balances[0].currency, "USD");

  const { metrics, subscribed } = parseEzaiclubSubscriptionsApi({
    code: 0,
    data: [{
      status: "active",
      expires_at: "2026-07-30T17:30:30.737779+08:00",
      weekly_usage_usd: 110.2226412,
      daily_usage_usd: 60.92,
      monthly_usage_usd: 110.22,
      group: {
        name: "Max周卡",
        weekly_limit_usd: 150,
        daily_limit_usd: 0,
        monthly_limit_usd: 0
      }
    }]
  });
  assert.equal(subscribed, true);
  assert.equal(metrics.some((item) => item.label === "当前套餐" && item.value === "Max周卡"), true);
  assert.equal(metrics.some((item) => item.label === "到期时间"), true);
  const weekly = metrics.find((item) => item.label === "Max周卡 每周");
  assert.ok(weekly);
  assert.equal(weekly.percent, 73);
  assert.match(weekly.value, /\$110\.22 \/ \$150\.00/);

  const snapshot = ezaiclubApiSnapshot(
    { id: "ezaiclub", name: "EZAICLUB", type: "ezaiclub", targetUrl: "https://www.ezaiclub.com/dashboard" },
    { code: 0, data: { balance: 10 } },
    { code: 0, data: [{ status: "active", group: { name: "Pro", weekly_limit_usd: 100 }, weekly_usage_usd: 50 }] }
  );
  assert.equal(snapshot.raw.source, "api");
  assert.equal(snapshot.balances[0].value, "10.00");
  assert.equal(snapshot.subscribed, true);
  assert.equal(snapshot.usage.length, 1);
});

test("EZAICLUB prefers API collection when auth_token is available", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const fetchUrls = [];
  let createdTabs = 0;

  globalThis.fetch = async (url, options = {}) => {
    fetchUrls.push(String(url));
    const auth = options.headers?.Authorization || "";
    if (!String(auth).includes("Bearer test-token")) {
      return { ok: false, status: 401, async json() { return { code: "UNAUTHORIZED" }; } };
    }
    if (String(url).includes("/api/v1/auth/me")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, message: "success", data: { balance: 12.345, frozen_balance: 0 } };
        }
      };
    }
    if (String(url).includes("/api/v1/subscriptions/active")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            data: [{
              status: "active",
              expires_at: "2026-08-01T00:00:00+08:00",
              weekly_usage_usd: 30,
              group: { name: "Pro Weekly", weekly_limit_usd: 100 }
            }]
          };
        }
      };
    }
    return { ok: true, status: 200, url, async text() { return "<html></html>"; } };
  };

  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 9, url: "https://www.ezaiclub.com/dashboard" }];
      },
      async create() {
        createdTabs += 1;
        throw new Error("API path should not open a new tab when an existing tab has auth_token");
      },
      async get() { return { id: 9, status: "complete" }; },
      async remove() {},
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      async executeScript({ args }) {
        if (Array.isArray(args) && args[0] === "auth_token") {
          return [{ result: "test-token" }];
        }
        throw new Error("DOM scrape should not run when API collection succeeds");
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?ezaiclub-api=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "ezaiclub",
    name: "EZAICLUB",
    type: "ezaiclub",
    targetUrl: "https://www.ezaiclub.com/dashboard",
    enabled: true,
    secondaryUrls: [{ label: "打开订阅页", url: "https://www.ezaiclub.com/subscriptions" }],
    mode: "page"
  });

  assert.equal(createdTabs, 0);
  assert.equal(snapshot.raw.source, "api");
  assert.equal(snapshot.balances[0].value, "12.35");
  assert.equal(snapshot.metrics.some((item) => item.label === "当前套餐" && item.value === "Pro Weekly"), true);
  assert.ok(fetchUrls.some((url) => url.includes("/api/v1/auth/me")));
  assert.ok(fetchUrls.some((url) => url.includes("/api/v1/subscriptions/active")));

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
