import { linksForConfig } from "./config.js";
import { classifyCollectionError, sanitizeDiagnosticMessage } from "../providers/runtime.js";

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
    channels: [],
    channelCheckedAt: null,
    channelsStale: false,
    channelError: null,
    links: linksForConfig(config),
    recommendation: ["error", "unconfigured", "needs_visit"].includes(status) ? "watch" : "ok",
    error
  };
}

export function errorSnapshot(config, previous, error) {
  const staleMetrics = previous?.metrics || [];
  const staleBalances = previous?.balances || [];
  const staleUsage = previous?.usage || [];
  const hasStaleData = Boolean(staleMetrics.length || staleBalances.length || staleUsage.length);
  const errorCode = classifyCollectionError(error);
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status: hasStaleData ? "stale" : errorCode === "NEEDS_VISIT" ? "needs_visit" : "error",
    url: config.targetUrl,
    updatedAt: previous?.updatedAt || null,
    checkedAt: nowIso(),
    subscribed: previous?.subscribed ?? null,
    balances: staleBalances,
    usage: staleUsage,
    metrics: staleMetrics,
    channels: previous?.channels || [],
    channelCheckedAt: previous?.channelCheckedAt || null,
    channelsStale: Boolean(previous?.channels?.length),
    channelError: previous?.channelError || null,
    links: previous?.links || linksForConfig(config),
    recommendation: previous?.recommendation || "watch",
    error: sanitizeDiagnosticMessage(error?.message || error),
    errorCode,
    ...(error?.collection ? {
      raw: {
        ...(previous?.raw && typeof previous.raw === "object" ? previous.raw : {}),
        collection: error.collection
      }
    } : {})
  };
}

export function preservePreviousChannels(snapshot, previous) {
  if (snapshot?.channels !== null) return snapshot;
  if (!Array.isArray(previous?.channels)) {
    return { ...snapshot, channels: [], channelsStale: false };
  }
  return {
    ...snapshot,
    channels: previous.channels,
    channelCheckedAt: previous.channelCheckedAt || null,
    channelsStale: true
  };
}

export function snapshotNeedsRetry(snapshot, { channelsOnly = false } = {}) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (channelsOnly && !["ezaiclub", "sub2api"].includes(snapshot.type)) return false;
  if (["error", "stale", "needs_visit"].includes(snapshot.status)) return true;
  return channelsOnly && (Boolean(snapshot.channelError) || snapshot.channelsStale === true);
}

/** Derive toolbar badge from the latest snapshots. */
export function badgeFromSnapshots(snapshots) {
  const list = Array.isArray(snapshots)
    ? snapshots.filter(Boolean)
    : Object.values(snapshots || {}).filter(Boolean);
  let errors = 0;
  let recharge = 0;
  let watch = 0;
  for (const snapshot of list) {
    if (snapshot.status === "error" || snapshot.status === "stale" || snapshot.status === "unconfigured") {
      errors += 1;
    } else if (snapshot.recommendation === "recharge") {
      recharge += 1;
    } else if (snapshot.recommendation === "watch") {
      watch += 1;
    }
  }
  if (errors) {
    return {
      text: String(Math.min(errors, 99)),
      color: "#c2410c",
      title: `Provider Usage Hub · ${errors} 个异常`
    };
  }
  if (recharge) {
    return {
      text: String(Math.min(recharge, 99)),
      color: "#d97706",
      title: `Provider Usage Hub · ${recharge} 个建议充值`
    };
  }
  if (watch) {
    return {
      text: String(Math.min(watch, 99)),
      color: "#ca8a04",
      title: `Provider Usage Hub · ${watch} 个需要关注`
    };
  }
  return {
    text: "",
    color: "#16803c",
    title: "Provider Usage Hub"
  };
}
