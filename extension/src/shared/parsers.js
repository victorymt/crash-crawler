import { linksForConfig } from "./config.js";
import {
  balanceMetric,
  nowIso,
  recommendationFromBalances,
  recommendationFromUsage,
  textMetric,
  usageMetric
} from "./snapshots.js";

export class ProviderError extends Error {}
export class NotLoggedInError extends ProviderError {}
export class ParserNeedsFixtureError extends ProviderError {}

export const OPENCODE_LOGIN_HINTS = [
  "/github/authorize",
  "/google/authorize",
  "Continue with GitHub",
  "Continue with Google"
];
export const EZAICLUB_LOGIN_HINTS = ["Login - EZAIClub", "Login", "Sign in", "Sign up", "登录"];
export const SILICONFLOW_LOGIN_HINTS = [
  "account.siliconflow.cn/login",
  "硅基流动统一登录",
  "Accelerate AGI to Benefit Humanity",
  "Blazing-fast, cost-effective Generative AI cloud services",
  "SiliconFlow Ambassador Program"
];
export const OPENCODE_USAGE_TYPES = ["滚动用量", "每周用量", "每月用量"];

export function htmlTokens(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function pageTextTokens(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function isLoginHtml(url, html, hints) {
  return hints.some((hint) => String(url || "").includes(hint) || String(html || "").includes(hint));
}

export function parsePercent(value) {
  const match = String(value || "").match(/^\s*(\d+)\s*%\s*$/);
  return match ? Number(match[1]) : null;
}

function nextNonUsageToken(tokens, start) {
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = String(tokens[idx] || "").trim();
    if (token && !OPENCODE_USAGE_TYPES.includes(token)) {
      return [token, idx];
    }
  }
  return [null, start];
}

export function parseOpencodeLegacy(tokens, url) {
  const joined = tokens.join("\n");
  const result = { url, subscribed: joined.includes("您已订阅 OpenCode Go"), usage: [] };
  let idx = 0;
  while (idx < tokens.length) {
    const usageType = tokens[idx];
    if (!OPENCODE_USAGE_TYPES.includes(usageType)) {
      idx += 1;
      continue;
    }
    const current = { type: usageType, percent: null, reset_in: null };
    result.usage.push(current);
    const [value, valueIdx] = nextNonUsageToken(tokens, idx + 1);
    if (value != null) {
      if (/^\d+%$/.test(value)) {
        current.percent = value;
        idx = valueIdx + 1;
      } else if (/^\d+$/.test(value)) {
        const [suffix, suffixIdx] = nextNonUsageToken(tokens, valueIdx + 1);
        if (suffix === "%") {
          current.percent = `${value}%`;
          idx = suffixIdx + 1;
        } else {
          idx = valueIdx + 1;
        }
      }
    }
    for (let lookahead = idx; lookahead < Math.min(idx + 6, tokens.length); lookahead += 1) {
      const token = tokens[lookahead];
      if (token.startsWith("重置于")) {
        const resetText = token.replace(/^重置于/, "").trim();
        if (resetText) {
          current.reset_in = resetText;
          idx = lookahead + 1;
        } else {
          const [resetValue, resetIdx] = nextNonUsageToken(tokens, lookahead + 1);
          if (resetValue != null) {
            current.reset_in = resetValue;
            idx = resetIdx + 1;
          }
        }
        break;
      }
    }
  }
  if (!result.usage.length) {
    throw new ParserNeedsFixtureError("usage data was not found in the opencode HTML");
  }
  return result;
}

export function deriveOpencodeBillingUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.at(-1) === "go") {
    parts[parts.length - 1] = "billing";
  } else {
    parts.push("billing");
  }
  parsed.pathname = `/${parts.join("/")}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function opencodeSnapshot(config, legacy) {
  const usage = (legacy.usage || []).map((item) => usageMetric(
    item.type,
    item.type,
    parsePercent(item.percent),
    item.percent,
    item.reset_in
  ));
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    url: legacy.url,
    updatedAt: nowIso(),
    checkedAt: nowIso(),
    subscribed: legacy.subscribed ?? null,
    balances: legacy.balances || [],
    usage,
    metrics: [...(legacy.balances || []), ...usage],
    links: linksForConfig(config),
    recommendation: recommendationFromUsage(usage),
    error: null,
    raw: legacy
  };
}

export function parseOpencodeBalanceTokens(tokens) {
  const balances = [];
  const seen = new Set();
  const keywords = ["余额", "balance", "Balance", "可用余额", "充值", "credit", "Credit"];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const window = tokens.slice(Math.max(0, idx - 2), Math.min(tokens.length, idx + 3));
    if (!keywords.some((word) => window.join("\n").includes(word))) continue;
    for (const item of window) {
      const match = String(item).match(/([$¥￥])\s*(\d+(?:\.\d+)?)/);
      if (!match) continue;
      const currency = match[1] === "$" ? "USD" : "CNY";
      const label = keywords.some((word) => token.includes(word)) ? token : "余额";
      const key = `${label}|${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      balances.push(balanceMetric("balance", label, match[2], currency));
    }
  }
  return balances;
}

export function parseDeepseekBalance(data, config) {
  const infos = data?.balance_infos;
  if (!Array.isArray(infos)) {
    throw new ProviderError("DeepSeek balance response did not include balance_infos");
  }
  const balances = [];
  for (const info of infos) {
    if (!info || typeof info !== "object") continue;
    const currency = info.currency || null;
    balances.push(balanceMetric("total_balance", "总余额", info.total_balance, currency));
    balances.push(balanceMetric("granted_balance", "赠金余额", info.granted_balance, currency));
    balances.push(balanceMetric("topped_up_balance", "充值余额", info.topped_up_balance, currency));
  }
  const usableBalances = balances.filter((item) => item.value !== "");
  if (!usableBalances.length) {
    throw new ProviderError("DeepSeek balance response did not contain usable balances");
  }
  const isAvailable = data?.is_available;
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    url: config.targetUrl,
    updatedAt: nowIso(),
    checkedAt: nowIso(),
    subscribed: null,
    isAvailable,
    balances: usableBalances,
    usage: [],
    metrics: usableBalances,
    links: linksForConfig(config),
    recommendation: recommendationFromBalances(usableBalances, isAvailable),
    error: null,
    raw: { is_available: isAvailable, balance_infos: infos }
  };
}

export function deepseekHttpErrorMessage(status) {
  if (status === 401) return "DeepSeek API Key is invalid or expired";
  if (status === 402) return "DeepSeek account has insufficient balance";
  if (status === 429) return "DeepSeek API rate limit was reached";
  return `DeepSeek balance API returned HTTP ${status}`;
}

function compileRulePattern(rule) {
  if (!rule?.pattern) return null;
  try {
    return new RegExp(rule.pattern, rule.flags || "");
  } catch {
    return null;
  }
}

function groupValue(match, group = 1) {
  if (!match) return "";
  return String(match[Number(group) || 1] ?? "").trim();
}

function currencyFromRule(rule, match) {
  const value = rule.currencyGroup ? groupValue(match, rule.currencyGroup) : "";
  if (value) return value === "¥" || value === "￥" || value.toUpperCase() === "RMB" || value === "元" ? "CNY" : value.toUpperCase();
  return rule.currency || null;
}

function scanRule(tokens, rule) {
  const pattern = compileRulePattern(rule);
  if (!pattern) return [];
  const matches = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = String(tokens[idx] || "").trim();
    if (!token) continue;
    const match = token.match(pattern);
    if (match) matches.push({ match, token, idx });
  }
  return matches;
}

function firstRuleValue(tokens, rule) {
  if (!rule?.pattern) return "";
  const found = scanRule(tokens, rule)[0];
  return groupValue(found?.match, rule.valueGroup ?? 1);
}

function genericResetValue(tokens, quotaIdx, rule) {
  if (!rule.resetPattern) return null;
  const resetRule = {
    pattern: rule.resetPattern,
    flags: rule.resetFlags || rule.flags || "",
    valueGroup: rule.resetGroup ?? 1
  };
  const window = tokens.slice(quotaIdx, Math.min(tokens.length, quotaIdx + Number(rule.resetLookahead || 6)));
  return firstRuleValue(window, resetRule) || firstRuleValue(tokens, resetRule) || null;
}

function genericValueFromRule(tokens, rule, match) {
  if (rule.staticValue != null) return String(rule.staticValue);
  if (rule.valuePattern) {
    return firstRuleValue(tokens, { pattern: rule.valuePattern, flags: rule.valueFlags || rule.flags || "", valueGroup: rule.valueGroup ?? 1 });
  }
  return groupValue(match, rule.valueGroup ?? 1);
}

export function parseGenericPageTokens(tokens, parserRules = {}) {
  const balances = [];
  const usage = [];
  const textMetrics = [];
  const seen = new Set();

  function addSeen(kind, label, value, extra = "") {
    const key = `${kind}|${label}|${value}|${extra}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  for (const rule of parserRules.balances || []) {
    for (const { match } of scanRule(tokens, rule)) {
      const label = rule.label || groupValue(match, rule.labelGroup) || "余额";
      const amount = groupValue(match, rule.valueGroup ?? 1);
      if (!amount || !addSeen("balance", label, amount, rule.currency || "")) continue;
      balances.push(balanceMetric(rule.key || "balance", label, normalizeAmount(amount), currencyFromRule(rule, match)));
      if (rule.limit && balances.length >= rule.limit) break;
    }
  }

  for (const rule of parserRules.quotas || []) {
    for (const { match, idx } of scanRule(tokens, rule)) {
      const label = rule.label || groupValue(match, rule.labelGroup) || "用量";
      const usedRaw = groupValue(match, rule.usedGroup ?? 1);
      const limitRaw = groupValue(match, rule.limitGroup ?? 2);
      const used = Number(usedRaw);
      const limit = Number(limitRaw);
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) continue;
      const symbol = rule.symbol || (rule.currency === "CNY" ? "¥" : "$");
      const value = `${symbol}${normalizeAmount(usedRaw)} / ${symbol}${normalizeAmount(limitRaw)}`;
      if (!addSeen("usage", label, value)) continue;
      usage.push(usageMetric(rule.key || "usage", label, Math.round((used / limit) * 100), value, genericResetValue(tokens, idx, rule)));
      if (rule.limit && usage.length >= rule.limit) break;
    }
  }

  for (const rule of parserRules.textMetrics || []) {
    for (const { match } of scanRule(tokens, rule)) {
      const label = rule.label || groupValue(match, rule.labelGroup) || "指标";
      const value = genericValueFromRule(tokens, rule, match);
      if (!value || !addSeen("text", label, value)) continue;
      textMetrics.push(textMetric(rule.key || `metric_${textMetrics.length + 1}`, label, value));
      if (rule.limit && textMetrics.length >= rule.limit) break;
    }
  }

  return { balances, usage, textMetrics, metrics: [...balances, ...usage, ...textMetrics] };
}

export function genericPageSnapshot(config, url, parsed) {
  const balances = parsed.balances || [];
  const usage = parsed.usage || [];
  const metrics = parsed.metrics || [...balances, ...usage, ...(parsed.textMetrics || [])];
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    url,
    updatedAt: nowIso(),
    checkedAt: nowIso(),
    subscribed: null,
    balances,
    usage,
    metrics,
    links: linksForConfig(config),
    recommendation: usage.length ? recommendationFromUsage(usage) : recommendationFromBalances(balances),
    error: metrics.length ? null : "Page loaded, but no configured provider rules matched",
    raw: { balance_count: balances.length, usage_count: usage.length, metric_count: metrics.length }
  };
}

export function normalizeAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : String(value);
}

export function parseMoneyValue(text) {
  const match = String(text || "").match(/([$¥￥])?\s*(\d+(?:\.\d+)?)\s*(CNY|RMB|USD|USDT|元)?/i);
  if (!match) return null;
  const [, symbol, amount, suffix] = match;
  let currency = "";
  if (symbol === "$") currency = "USD";
  else if (symbol === "¥" || symbol === "￥") currency = "CNY";
  else if (suffix) {
    const normalized = suffix.toUpperCase();
    currency = ["RMB", "元"].includes(normalized) ? "CNY" : normalized;
  }
  return [amount, currency];
}

export function parseEzaiclubBalanceTokens(tokens) {
  const balances = [];
  const seen = new Set();
  const keywords = ["余额", "充值", "可用", "剩余", "balance", "Balance", "credit", "Credit", "wallet", "Wallet"];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const window = tokens.slice(Math.max(0, idx - 2), Math.min(tokens.length, idx + 4));
    if (!keywords.some((keyword) => window.join("\n").includes(keyword))) continue;
    const label = window.find((item) => keywords.some((keyword) => item.includes(keyword))) || token;
    for (const item of window) {
      const parsed = parseMoneyValue(item);
      if (!parsed) continue;
      const [amountRaw, currency] = parsed;
      const amount = normalizeAmount(amountRaw);
      const key = `balance|${label}|${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      balances.push(balanceMetric("balance", label, amount, currency || null));
    }
  }
  const currencyBalances = balances.filter((item) => item.currency);
  if (currencyBalances.length) {
    const preferredLabels = ["余额", "账户余额", "可用余额", "可用", "balance", "Balance"];
    const ordered = [...currencyBalances].sort((a, b) => {
      return (preferredLabels.includes(a.label) ? 0 : 1) - (preferredLabels.includes(b.label) ? 0 : 1);
    });
    const deduped = [];
    const seenAmounts = new Set();
    for (const item of ordered) {
      const key = `${item.value}|${item.currency || ""}`;
      if (seenAmounts.has(key)) continue;
      seenAmounts.add(key);
      deduped.push(item);
    }
    return deduped.slice(0, 3);
  }
  return balances.slice(0, 3);
}

export function flattenJsonValues(value) {
  const result = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      result.push(String(key));
      result.push(...flattenJsonValues(item));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) result.push(...flattenJsonValues(item));
  } else if (value != null) {
    result.push(String(value));
  }
  return result;
}

export function extractJsonPayloads(responses) {
  return responses.flatMap((response) => flattenJsonValues(response?.data)).map((token) => token.trim()).filter(Boolean);
}

function nextSubscriptionValue(tokens, start) {
  const skipWords = [
    "订阅",
    "套餐",
    "subscription",
    "Subscription",
    "plan",
    "Plan",
    "planName",
    "plan_name",
    "expiresAt",
    "expires_at",
    "endDate",
    "renewAt",
    "renew_at",
    "有效",
    "续费"
  ];
  for (let idx = start; idx < Math.min(start + 4, tokens.length); idx += 1) {
    const token = String(tokens[idx] || "").trim();
    if (!token || skipWords.includes(token)) continue;
    if (token.length > 120) continue;
    return token;
  }
  return null;
}

function normalizeSubscriptionLabel(label) {
  const clean = String(label || "").trim();
  const mapping = [
    [/^(plan_name|planName|subscription_plan|subscriptionPlan)$/i, "当前套餐"],
    [/^(expires_at|expiresAt|endDate|renewAt|renew_at)$/i, "到期时间"],
    [/^(subscription_status|status)$/i, "订阅状态"],
    [/^(subscription_usage|usage)$/i, "订阅用量"],
    [/^(current_plan|currentPlan)$/i, "当前套餐"]
  ];
  for (const [pattern, normalized] of mapping) {
    if (pattern.test(clean)) return normalized;
  }
  return clean;
}

function formatSubscriptionAmount(amount) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : String(amount);
}

function subscriptionResetNear(tokens, idx) {
  for (const token of tokens.slice(idx + 1, idx + 5)) {
    const match = String(token || "").trim().match(/(.+?)\s*后重置/);
    if (match) return match[1].trim();
  }
  return null;
}

function subscriptionPeriodNear(tokens, idx) {
  const periodMap = new Map([
    ["每日", "每日"],
    ["每天", "每日"],
    ["每周", "每周"],
    ["每月", "每月"],
    ["daily", "每日"],
    ["weekly", "每周"],
    ["monthly", "每月"]
  ]);
  for (const token of tokens.slice(Math.max(0, idx - 5), idx).reverse()) {
    const clean = String(token || "").trim();
    const mapped = periodMap.get(clean) || periodMap.get(clean.toLowerCase());
    if (mapped) return mapped;
  }
  return null;
}

function subscriptionExpiryNear(tokens, idx, dateRe) {
  const window = tokens.slice(Math.max(0, idx - 4), idx + 5).join("\n");
  const remainingMatch = window.match(/剩余\s*[^()]*\(([^)]+)\)/);
  if (remainingMatch) return remainingMatch[1].trim();
  const dateMatch = window.match(dateRe);
  return dateMatch?.[0] || null;
}

export function parseEzaiclubSubscriptionTokens(tokens) {
  const metrics = [];
  const seen = new Set();
  const navTokens = new Set(["充值/订阅", "模型价格", "文档", "查看您的订阅计划和用量", "我的订阅", "Subscriptions", "Subscription"]);
  const keywords = [
    "订阅",
    "套餐",
    "到期",
    "续费",
    "有效",
    "subscription",
    "Subscription",
    "plan",
    "Plan",
    "planName",
    "plan_name",
    "currentPlan",
    "current_plan",
    "active",
    "Active",
    "expires",
    "Expires",
    "expiresAt",
    "expires_at",
    "endDate",
    "renew",
    "Renew",
    "renewAt",
    "renew_at",
    "status",
    "usage",
    "subscription_status",
    "subscription_usage"
  ];
  const dateRe = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:[ T]\d{1,2}:\d{2})?|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}/;
  const quotaPairRe = /([$¥￥])\s*(\d+(?:\.\d+)?)\s*\/\s*([$¥￥])?\s*(\d+(?:\.\d+)?)/;
  const periodFields = [
    ["daily", "每日"],
    ["weekly", "每周"],
    ["monthly", "每月"]
  ];

  function addText(label, value, keyName = null) {
    const normalizedLabel = normalizeSubscriptionLabel(label);
    let normalizedValue = String(value || "").trim();
    if (!normalizedValue || navTokens.has(normalizedValue)) return;
    if (normalizedLabel === "到期时间") normalizedValue = normalizedValue.replace("T", " ");
    if (normalizedValue === "allowed_groups" || (normalizedValue.includes("_") && normalizedLabel !== "到期时间")) return;
    const key = `${normalizedLabel}|${normalizedValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    metrics.push(textMetric(keyName || `subscription_${metrics.length + 1}`, normalizedLabel, normalizedValue));
  }

  function addUsage(label, value, percent, resetIn) {
    const key = `${label}|${value}`;
    if (seen.has(key)) {
      if (resetIn) {
        const metric = metrics.find((item) => item.label === label && item.value === value && !item.resetIn && !item.reset_in);
        if (metric) metric.resetIn = resetIn;
      }
      return;
    }
    seen.add(key);
    metrics.push(usageMetric("subscription_usage", label, percent, value, resetIn));
  }

  function addApiUsage(period, labelPrefix) {
    const usageKey = `${period}_usage_usd`;
    const limitKey = `${period}_limit_usd`;
    const usageIdx = tokens.findIndex((token) => String(token || "").trim() === usageKey);
    const limitIdx = tokens.findIndex((token) => String(token || "").trim() === limitKey);
    if (usageIdx < 0 || limitIdx < 0 || usageIdx + 1 >= tokens.length || limitIdx + 1 >= tokens.length) return false;
    const usedRaw = String(tokens[usageIdx + 1] || "").trim();
    const limitRaw = String(tokens[limitIdx + 1] || "").trim();
    const used = Number(usedRaw);
    const limit = Number(limitRaw);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return false;
    addUsage(
      `${labelPrefix}用量`,
      `$${formatSubscriptionAmount(usedRaw)} / $${formatSubscriptionAmount(limitRaw)}`,
      Math.round((used / limit) * 100),
      null
    );
    return true;
  }

  let hasUsageQuota = false;
  for (const [period, labelPrefix] of periodFields) {
    hasUsageQuota = addApiUsage(period, labelPrefix) || hasUsageQuota;
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const clean = String(tokens[idx] || "").trim();
    const quotaMatch = clean.match(quotaPairRe);
    if (!quotaMatch) continue;
    const [, symbol, usedRaw, limitSymbol, limitRaw] = quotaMatch;
    const used = Number(usedRaw);
    const limit = Number(limitRaw);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) continue;
    const labelPrefix = subscriptionPeriodNear(tokens, idx);
    const label = labelPrefix ? `${labelPrefix}用量` : "订阅用量";
    const displaySymbol = symbol || limitSymbol || "$";
    const value = `${displaySymbol}${formatSubscriptionAmount(usedRaw)} / ${limitSymbol || displaySymbol}${formatSubscriptionAmount(limitRaw)}`;
    addUsage(label, value, Math.round((used / limit) * 100), subscriptionResetNear(tokens, idx));
    hasUsageQuota = true;
    const expiresAt = subscriptionExpiryNear(tokens, idx, dateRe);
    if (expiresAt) addText("到期时间", expiresAt);
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const clean = String(tokens[idx] || "").trim();
    if (!clean || !keywords.some((keyword) => clean.includes(keyword))) continue;
    if (["Subscriptions", "Subscription", "订阅"].includes(clean)) continue;
    if (navTokens.has(clean)) continue;
    if (["last_active_at", "有效", "续费"].includes(clean) || clean.includes("同一订阅重复")) continue;
    if (/^(daily|weekly|monthly)_(usage|limit)_usd$/.test(clean)) continue;
    if (clean.length > 48 && !clean.includes("已达到")) continue;
    const percentMatch = clean.match(/已达到\s*(\d+)%/);
    if (percentMatch) {
      if (hasUsageQuota) continue;
      const dateMatch = tokens.slice(idx, idx + 5).join("\n").match(dateRe);
      let value = `${percentMatch[1]}%`;
      if (dateMatch) value = `${value}, 到期 ${dateMatch[0]}`;
      addText("订阅用量", value, "subscription_usage");
      continue;
    }
    let value = nextSubscriptionValue(tokens, idx + 1);
    const dateMatch = tokens.slice(idx, idx + 5).join("\n").match(dateRe);
    if (dateMatch && ["到期", "续费", "有效", "expires", "Expires", "renew", "Renew"].some((word) => clean.includes(word))) {
      value = dateMatch[0];
    }
    if (!value && clean.length <= 120) value = clean;
    if (!value || navTokens.has(value) || value.includes("_") || value === "allowed_groups") continue;
    addText(clean, value);
    if (metrics.length >= 6) break;
  }
  return metrics;
}

export function parseSiliconflowBalanceTokens(tokens) {
  const balances = [];
  const seen = new Set();
  const keywords = ["余额", "可用", "剩余", "赠金", "充值", "券", "优惠券", "代金券", "coupon", "Coupon", "credit", "Credit", "balance", "Balance", "amount", "Amount"];
  const preferredLabels = ["可用余额", "账户余额", "余额", "赠金", "优惠券", "代金券", "balance", "Balance"];

  function addBalance(label, amount, currency) {
    const normalized = normalizeAmount(amount);
    const key = `${label}|${normalized}|${currency || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    balances.push(balanceMetric("balance", label, normalized, currency || null));
  }

  function previousCouponLabel(idx) {
    for (const item of tokens.slice(Math.max(0, idx - 4), idx).reverse()) {
      const clean = String(item || "").trim();
      if (!clean || clean.length > 48) continue;
      if (/^\d+(?:\.\d+)?$/.test(clean)) continue;
      if (["全部", "可用", "兑换中心"].includes(clean)) continue;
      return clean;
    }
    return null;
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const quotaMatch = String(token).match(/剩余额度[:：]\s*([$¥￥])?\s*(\d+(?:\.\d+)?)\s*(CNY|RMB|USD|USDT|元)?/i);
    if (quotaMatch) {
      const [, symbol, amount, suffix] = quotaMatch;
      let currency = null;
      if (symbol === "$") currency = "USD";
      else if (symbol === "¥" || symbol === "￥") currency = "CNY";
      else if (suffix) {
        const normalized = suffix.toUpperCase();
        currency = ["RMB", "元"].includes(normalized) ? "CNY" : normalized;
      }
      const prefix = previousCouponLabel(idx);
      addBalance(prefix ? `${prefix}剩余额度` : "剩余额度", amount, currency);
      continue;
    }

    const window = tokens.slice(Math.max(0, idx - 2), Math.min(tokens.length, idx + 5));
    if (!keywords.some((keyword) => window.join("\n").includes(keyword))) continue;
    const keywordItems = window
      .map((item, offset) => ({ item, offset }))
      .filter(({ item }) => keywords.some((keyword) => item.includes(keyword)));
    for (let offset = 0; offset < window.length; offset += 1) {
      const clean = String(window[offset] || "").trim();
      if (!clean || clean.length > 80) continue;
      if (/\d{4}[-/年]\d{1,2}|^\d+%$/.test(clean)) continue;
      const nearCurrency = window
        .map((item) => item.trim().toUpperCase())
        .find((item) => ["CNY", "RMB", "USD", "USDT", "元"].includes(item));
      const hasCurrency = /[$¥￥]|(?:CNY|RMB|USD|USDT|元)\b/i.test(clean) || Boolean(nearCurrency);
      if (!hasCurrency) continue;
      const parsed = parseMoneyValue(clean);
      if (!parsed) continue;
      let label = keywordItems.length
        ? keywordItems.reduce((best, item) => Math.abs(item.offset - offset) < Math.abs(best.offset - offset) ? item : best).item
        : token;
      if (label.length > 80) label = token;
      label = label.replace(/[（(]?\s*[$¥￥]\s*\d+(?:\.\d+)?\s*[）)]?/g, "").trim().replace(/^[（）() ]+|[（）() ]+$/g, "") || label;
      const [amount, currency] = parsed;
      const normalizedNearCurrency = nearCurrency === "RMB" || nearCurrency === "元" ? "CNY" : nearCurrency;
      addBalance(label, amount, currency || normalizedNearCurrency || null);
    }
  }

  const ordered = [...balances].sort((a, b) => {
    return (preferredLabels.includes(a.label) ? 0 : 1) - (preferredLabels.includes(b.label) ? 0 : 1);
  });
  const deduped = [];
  const seenAmounts = new Set();
  for (const item of ordered) {
    const key = `${item.value}|${item.currency || ""}`;
    if (seenAmounts.has(key)) continue;
    seenAmounts.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 5);
}

export function parseSiliconflowMetricTokens(tokens) {
  const metrics = [];
  const seen = new Set();
  const keywords = ["账单", "费用", "消费", "消耗", "使用", "到期", "有效", "过期", "充值", "expense", "Expense", "bill", "Bill", "used", "Used", "expires", "Expires", "valid", "Valid"];
  const ignoredLabels = new Set(["used", "expiresAt", "quota", "total", "remain", "remaining", "余额充值", "费用明细"]);
  const dateRe = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:\s*~\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2})?|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}/;

  function addMetric(label, value) {
    const key = `${label}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    metrics.push(textMetric(`siliconflow_metric_${metrics.length + 1}`, label, value));
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const clean = String(tokens[idx] || "").trim();
    if (!clean || clean.length > 80 || ignoredLabels.has(clean)) continue;
    if (clean === "代金券" && idx + 2 < tokens.length) {
      const count = String(tokens[idx + 1] || "").trim();
      const suffix = String(tokens[idx + 2] || "").trim();
      if (/^\d+$/.test(count) && suffix.includes("张可用")) addMetric("代金券", `${count} 张可用`);
      continue;
    }
    if (!keywords.some((keyword) => clean.includes(keyword))) continue;
    const window = tokens.slice(idx, Math.min(tokens.length, idx + 5));
    const dateMatch = window.join("\n").match(dateRe);
    let value = dateMatch?.[0] || null;
    if (value == null) {
      value = window.slice(1).find((item) => {
        const cleanItem = String(item || "").trim();
        return cleanItem.length <= 80 && /[$¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:CNY|RMB|USD|USDT|元)\b|\d+%/i.test(cleanItem);
      }) || null;
    }
    if (!value) continue;
    addMetric(clean, value.trim());
    if (metrics.length >= 6) break;
  }
  return metrics;
}

export function siliconflowSnapshot(config, url, balances, metrics) {
  const allMetrics = [...balances, ...metrics];
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    url,
    updatedAt: nowIso(),
    checkedAt: nowIso(),
    subscribed: null,
    balances,
    usage: [],
    metrics: allMetrics,
    links: linksForConfig(config),
    recommendation: recommendationFromBalances(balances),
    error: allMetrics.length ? null : "SiliconFlow page loaded, but no balance or coupon fields were recognized",
    raw: { balance_count: balances.length, metric_count: metrics.length }
  };
}

export function ezaiclubSnapshot(config, dashboardUrl, balances, subscriptionMetrics) {
  const metrics = [...balances, ...subscriptionMetrics];
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: "ok",
    url: dashboardUrl,
    updatedAt: nowIso(),
    checkedAt: nowIso(),
    subscribed: null,
    balances,
    usage: [],
    metrics,
    links: linksForConfig(config),
    recommendation: recommendationFromBalances(balances),
    error: metrics.length ? null : "EZAICLUB pages loaded, but no balance or subscription fields were recognized",
    raw: { balance_count: balances.length, subscription_metric_count: subscriptionMetrics.length }
  };
}
