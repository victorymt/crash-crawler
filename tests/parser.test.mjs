import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDeepseekBalance,
  parseEzaiclubBalanceTokens,
  parseEzaiclubSubscriptionTokens,
  parseGenericPageTokens,
  parseOpencodeLegacy,
  parsePercent,
  parseSiliconflowBalanceTokens,
  parseSiliconflowMetricTokens
} from "../extension/src/shared/parsers.js";

const deepseekConfig = {
  id: "deepseek",
  name: "DeepSeek",
  type: "deepseek",
  targetUrl: "https://platform.deepseek.com/usage",
  secondaryUrls: []
};

test("parsePercent", () => {
  assert.equal(parsePercent("35%"), 35);
  assert.equal(parsePercent(" 100% "), 100);
  assert.equal(parsePercent("35"), null);
});

test("parseOpencodeLegacy", () => {
  const result = parseOpencodeLegacy([
    "滚动用量",
    "23%",
    "重置于 3 小时 3 分钟",
    "每周用量",
    "19%",
    "重置于 6 天 7 小时",
    "每月用量",
    "96%",
    "重置于 8 天 19 小时"
  ], "https://example.test");
  assert.equal(result.usage.length, 3);
  assert.equal(result.usage[0].percent, "23%");
  assert.equal(result.usage[2].reset_in, "8 天 19 小时");
});

test("parseDeepseekBalance", () => {
  const result = parseDeepseekBalance({
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "12.50",
        granted_balance: "2.50",
        topped_up_balance: "10.00"
      }
    ]
  }, deepseekConfig);
  assert.equal(result.status, "ok");
  assert.equal(result.recommendation, "ok");
  assert.equal(result.balances[0].label, "总余额");
  assert.equal(result.balances[0].value, "12.50");
});

test("parseEzaiclubBalanceTokens", () => {
  const balances = parseEzaiclubBalanceTokens(["Dashboard", "账户余额", "¥ 88.60", "充值"]);
  assert.equal(balances[0].key, "balance");
  assert.equal(balances[0].value, "88.60");
  assert.equal(balances[0].currency, "CNY");
  assert.equal(parseEzaiclubBalanceTokens(["余额", "1", "$20.8356166"])[0].value, "20.84");
});

test("parseEzaiclubSubscriptionTokens", () => {
  const metrics = parseEzaiclubSubscriptionTokens(["Subscriptions", "当前套餐", "Pro Monthly", "到期时间", "2026-08-21"]);
  assert.ok(metrics.length);
  assert.equal(metrics[0].label, "当前套餐");
  assert.equal(metrics[0].value, "Pro Monthly");
  const usage = parseEzaiclubSubscriptionTokens(["已达到 95%，但到期前没有可提前重置的窗口。", "2026/07/28"]);
  assert.equal(usage[0].label, "订阅用量");
  const liveUsage = parseEzaiclubSubscriptionTokens([
    "Lite周卡",
    "OpenAI",
    "倍率: ×1.2",
    "已达到 95%，但到期前没有可提前重置的窗口。",
    "有效",
    "续费",
    "到期时间",
    "剩余 6天13小时 (2026/07/29 00:17)",
    "每周",
    "$50.15 / $50.00",
    "6天13小时 后重置"
  ]);
  assert.equal(liveUsage[0].label, "每周用量");
  assert.equal(liveUsage[0].value, "$50.15 / $50.00");
  assert.equal(liveUsage[0].percent, 100);
  assert.equal(liveUsage[0].resetIn, "6天13小时");
  assert.equal(liveUsage[1].label, "到期时间");
  assert.equal(liveUsage[1].value, "2026/07/29 00:17");
  assert.equal(liveUsage.some((item) => ["有效", "续费"].includes(item.label)), false);
});

test("parseEzaiclubSubscriptionTokens handles JSON field names", () => {
  const metrics = parseEzaiclubSubscriptionTokens([
    "planName",
    "Pro Monthly",
    "expiresAt",
    "2026-08-21",
    "subscription_status",
    "active"
  ]);
  assert.equal(metrics[0].label, "当前套餐");
  assert.equal(metrics[0].value, "Pro Monthly");
  assert.equal(metrics[1].label, "到期时间");
  assert.equal(metrics[1].value, "2026-08-21");
  const apiUsage = parseEzaiclubSubscriptionTokens([
    "weekly_usage_usd",
    "50.1509256",
    "monthly_usage_usd",
    "100.5876372",
    "weekly_limit_usd",
    "50",
    "monthly_limit_usd",
    "0",
    "expires_at",
    "2026-07-29T00:17:57.582205+08:00"
  ]);
  assert.equal(apiUsage[0].label, "每周用量");
  assert.equal(apiUsage[0].value, "$50.15 / $50.00");
  assert.equal(apiUsage[1].label, "到期时间");
  assert.equal(apiUsage[1].value, "2026-07-29 00:17");
  const combinedUsage = parseEzaiclubSubscriptionTokens([
    "weekly_usage_usd",
    "50.1509256",
    "weekly_limit_usd",
    "50",
    "每周",
    "$50.15 / $50.00",
    "6天13小时 后重置"
  ]);
  assert.equal(combinedUsage[0].resetIn, "6天13小时");
});

test("parseGenericPageTokens parses configurable page rules", () => {
  const parsed = parseGenericPageTokens([
    "Dashboard",
    "账户余额",
    "$74.84",
    "Lite周卡",
    "到期时间",
    "剩余 6天13小时 (2026/07/29 00:17)",
    "每周",
    "$50.15 / $50.00",
    "6天13小时 后重置"
  ], {
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
  });
  assert.equal(parsed.balances[0].value, "74.84");
  assert.equal(parsed.usage[0].label, "每周用量");
  assert.equal(parsed.usage[0].value, "$50.15 / $50.00");
  assert.equal(parsed.usage[0].percent, 100);
  assert.equal(parsed.usage[0].resetIn, "6天13小时");
  assert.equal(parsed.textMetrics[0].value, "2026/07/29 00:17");
});

test("parseSiliconflowBalanceTokens", () => {
  const balances = parseSiliconflowBalanceTokens(["费用账单", "可用余额", "¥ 23.50", "优惠券", "10.00 CNY"]);
  assert.equal(balances[0].label, "可用余额");
  assert.equal(balances[0].value, "23.50");
  assert.equal(balances[0].currency, "CNY");
  assert.equal(balances[1].label, "优惠券");
  assert.equal(balances[1].value, "10.00");
});

test("parseSiliconflowMetricTokens", () => {
  const balances = parseSiliconflowBalanceTokens(["couponBalance", "3.456", "balance", "8.9", "currency", "CNY"]);
  assert.deepEqual(new Set(balances.map((item) => item.value)), new Set(["3.46", "8.90"]));
  const metrics = parseSiliconflowMetricTokens(["有效期", "2026-08-21", "账单金额", "1.20"]);
  assert.equal(metrics[0].label, "有效期");
  assert.equal(metrics[0].value, "2026-08-21");
});
