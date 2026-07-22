import { linksForConfig } from "./config.js";

export function nowIso() {
  return new Date().toISOString();
}

export function balanceMetric(key, label, value, currency = null) {
  return {
    key,
    label,
    value: value == null ? "" : String(value),
    currency
  };
}

export function textMetric(key, label, value) {
  return {
    key,
    label,
    value: value || "",
    unit: null,
    percent: null,
    resetIn: null
  };
}

export function usageMetric(key, label, percent, value, resetIn = null) {
  return {
    key,
    label,
    percent,
    value,
    unit: "%",
    resetIn
  };
}

export function recommendationFromUsage(usage) {
  const highest = usage.reduce((max, item) => {
    return Number.isInteger(item.percent) ? Math.max(max, item.percent) : max;
  }, 0);
  if (highest >= 100) return "recharge";
  if (highest >= 80) return "watch";
  return "ok";
}

export function recommendationFromBalances(balances, isAvailable = true) {
  if (isAvailable === false) return "recharge";
  const totals = balances
    .filter((item) => ["total_balance", "balance"].includes(item.key))
    .map((item) => String(item.value || ""))
    .filter((value) => /^-?\d+(?:\.\d+)?$/.test(value))
    .map(Number);
  if (!totals.length) return "watch";
  const max = Math.max(...totals);
  if (max <= 0) return "recharge";
  if (max < 5) return "watch";
  return "ok";
}

export function blankSnapshot(config, status = "idle", error = null) {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status,
    url: config.targetUrl,
    updatedAt: null,
    checkedAt: null,
    subscribed: null,
    balances: [],
    usage: [],
    metrics: [],
    links: linksForConfig(config),
    recommendation: ["error", "unconfigured"].includes(status) ? "watch" : "ok",
    error
  };
}

export function errorSnapshot(config, previous, error) {
  const staleMetrics = previous?.metrics || [];
  const staleBalances = previous?.balances || [];
  const staleUsage = previous?.usage || [];
  const hasStaleData = Boolean(staleMetrics.length || staleBalances.length || staleUsage.length);
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: hasStaleData ? "stale" : "error",
    url: config.targetUrl,
    updatedAt: previous?.updatedAt || null,
    checkedAt: nowIso(),
    subscribed: previous?.subscribed ?? null,
    balances: staleBalances,
    usage: staleUsage,
    metrics: staleMetrics,
    links: previous?.links || linksForConfig(config),
    recommendation: previous?.recommendation || "watch",
    error: error?.message || String(error)
  };
}
