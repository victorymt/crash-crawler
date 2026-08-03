const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function apiData(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.data != null ? payload.data : payload;
}

function finiteNumber(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dividedMultiplier(value, divisor) {
  return value == null ? null : Number((value / divisor).toFixed(8));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function modelName(value) {
  return typeof value === "string" ? value : value?.name || value?.model || "";
}

function parseClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function timeZoneMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

export function isPeakRateActive(group, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  if (group?.peak_rate_enabled !== true) return false;
  const start = parseClock(group.peak_start);
  const end = parseClock(group.peak_end);
  const current = timeZoneMinutes(now, timeZone);
  if (start == null || end == null || current == null || start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function rateValue(value) {
  if (value && typeof value === "object") {
    return finiteNumber(value.rate_multiplier ?? value.rateMultiplier ?? value.rate ?? value.multiplier ?? value.value);
  }
  return finiteNumber(value);
}

function groupRateOverride(payload, groupId) {
  const data = apiData(payload);
  if (data == null || groupId == null) return null;
  const id = String(groupId);
  if (Array.isArray(data)) {
    const entry = data.find((item) => String(item?.group_id ?? item?.groupId ?? item?.id ?? "") === id);
    return rateValue(entry);
  }
  const containers = [data, data.rates, data.groups, data.items].filter((item) => item && typeof item === "object");
  for (const container of containers) {
    if (Array.isArray(container)) {
      const entry = container.find((item) => String(item?.group_id ?? item?.groupId ?? item?.id ?? "") === id);
      const value = rateValue(entry);
      if (value != null) return value;
      continue;
    }
    const value = rateValue(container[id]);
    if (value != null) return value;
  }
  return null;
}

export function effectiveGroupRate(group, ratesPayload = null, now = new Date()) {
  const baseMultiplier = finiteNumber(group?.rate_multiplier ?? group?.rateMultiplier);
  const userMultiplier = groupRateOverride(ratesPayload, group?.id);
  const peakMultiplier = finiteNumber(group?.peak_rate_multiplier ?? group?.peakRateMultiplier);
  const peakActive = isPeakRateActive(group, now);
  const regularMultiplier = userMultiplier ?? baseMultiplier;
  return {
    baseMultiplier,
    userMultiplier,
    peakMultiplier,
    peakActive,
    effectiveMultiplier: peakActive && peakMultiplier != null ? peakMultiplier : regularMultiplier,
    rateSource: peakActive && peakMultiplier != null
      ? "peak"
      : userMultiplier != null
        ? "user"
        : baseMultiplier != null
          ? "group"
          : "unknown"
  };
}

export function multiplierFromName(name) {
  const match = String(name || "").match(/(\d+(?:\.\d+)?)\s*(?:x|×|倍(?:率)?)/i);
  return match ? finiteNumber(match[1]) : null;
}

function normalizedChannelName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\[(?=[^\]]*(?:\d+(?:\.\d+)?\s*(?:x|×|倍)|倍率|限时|保\s*\d*%|不稳定|稳定|缓存))[^\]]*\]/gi, "")
    .replace(/【(?=[^】]*(?:\d+(?:\.\d+)?\s*(?:x|×|倍)|倍率|限时|保\s*\d*%|不稳定|稳定|缓存))[^】]*】/gi, "")
    .replace(/\([^)]*(?:\d+(?:\.\d+)?\s*(?:x|×|倍)|倍率|限时|保\s*\d*%|不稳定|稳定|缓存)[^)]*\)/gi, "")
    .replace(/（[^）]*(?:\d+(?:\.\d+)?\s*(?:x|×|倍)|倍率|限时|保\s*\d*%|不稳定|稳定|缓存)[^）]*）/gi, "")
    .replace(/\d+(?:\.\d+)?\s*(?:x|×|倍(?:率)?)/gi, "")
    .replace(/(?:通用余额|渠道|分组|线路|channel|group)/g, "")
    .replace(/(?:openai|anthropic|grok|claude|google|azure)/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function groupEntries(payload) {
  const data = apiData(payload);
  if (Array.isArray(data)) {
    const isFlatGroups = data.some((item) => item && typeof item === "object" && item.platform && !item.platforms);
    if (isFlatGroups) {
      return data.map((group) => ({
        group,
        categoryName: "",
        platform: group.platform || ""
      }));
    }
  }
  const nested = data?.items || data?.channels;
  const categories = Array.isArray(data) ? data : Array.isArray(nested) ? nested : [];
  const entries = [];
  for (const category of categories) {
    for (const platformEntry of category?.platforms || []) {
      const supportedModels = uniqueStrings((platformEntry.supported_models || platformEntry.models || []).map(modelName));
      for (const group of platformEntry.groups || []) {
        entries.push({ group: { ...group, supportedModels }, categoryName: category.name || "", platform: group.platform || platformEntry.platform || "" });
      }
    }
  }
  return entries;
}

function flattenAvailableGroups(payload, ratesPayload, now) {
  const groups = [];
  for (const entry of groupEntries(payload)) {
    const group = entry.group || {};
    groups.push({
      ...group,
      categoryName: entry.categoryName || "",
      platform: group.platform || entry.platform || "",
      supportedModels: uniqueStrings((group.supportedModels || group.supported_models || group.models || []).map(modelName)),
      normalizedName: normalizedChannelName(group.name),
      ...effectiveGroupRate(group, ratesPayload, now)
    });
  }
  return groups;
}

function monitorItems(payload) {
  const data = apiData(payload);
  if (Array.isArray(data)) return data;
  const items = data?.items || data?.monitors;
  return Array.isArray(items) ? items : [];
}

function chooseGroup(monitor, groups) {
  const platform = String(monitor.provider || monitor.platform || "").toLowerCase();
  const monitorRate = multiplierFromName(monitor.name);
  const monitorName = normalizedChannelName(monitor.name);
  const candidates = groups
    .filter((group) => String(group.platform || "").toLowerCase() === platform)
    .map((group) => {
      const groupRate = group.baseMultiplier ?? multiplierFromName(group.name);
      const sameRate = monitorRate != null && groupRate != null && Math.abs(monitorRate - groupRate) < 1e-9;
      const sameName = Boolean(monitorName && group.normalizedName && monitorName === group.normalizedName);
      const relatedName = Boolean(
        monitorName && group.normalizedName
        && (monitorName.includes(group.normalizedName)
          || group.normalizedName.includes(monitorName)
          || commonNameFragment(monitorName, group.normalizedName))
      );
      const explicitGroup = [monitor.group_id, monitor.groupId, monitor.group?.id]
        .filter((value) => value != null)
        .some((value) => String(value) === String(group.id));
      return {
        group,
        explicitGroup,
        sameRate,
        sameName,
        relatedName,
        score: (explicitGroup ? 200 : 0)
          + (sameName ? 100 : relatedName ? 60 : 0)
          + (sameRate ? 30 : monitorRate != null && groupRate != null ? -20 : 0)
      };
    })
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 40 || (candidates[1] && candidates[1].score === best.score)) return null;
  return {
    ...best.group,
    matchConfidence: best.explicitGroup
      ? "explicit"
      : best.sameRate && best.sameName
        ? "exact"
        : best.sameRate && best.relatedName
          ? "high"
          : best.sameName || best.relatedName
            ? "name"
            : "rate"
  };
}

function commonNameFragment(left, right) {
  if (!left || !right) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  for (let size = Math.min(shorter.length, 8); size >= 4; size -= 1) {
    for (let index = 0; index + size <= shorter.length; index += 1) {
      if (longer.includes(shorter.slice(index, index + size))) return true;
    }
  }
  return false;
}

function monitorModels(monitor) {
  return [
    {
      model: monitor.primary_model || "",
      status: monitor.primary_status || "unknown",
      latencyMs: finiteNumber(monitor.primary_latency_ms),
      source: "primary"
    },
    ...(monitor.extra_models || []).map((item) => ({
      model: modelName(item),
      status: item.status || item.latest_status || "unknown",
      latencyMs: finiteNumber(item.latency_ms ?? item.latest_latency_ms),
      source: "extra"
    }))
  ].filter((item) => item.model);
}

function monitorTimeline(monitor, limit = 30) {
  const timeline = Array.isArray(monitor?.timeline) ? monitor.timeline : [];
  return timeline.slice(0, limit).map((item) => ({
    status: String(item?.status || "unknown"),
    latencyMs: finiteNumber(item?.latency_ms ?? item?.latencyMs),
    pingLatencyMs: finiteNumber(item?.ping_latency_ms ?? item?.pingLatencyMs),
    checkedAt: item?.checked_at || item?.checkedAt || null
  }));
}

function monitorUrl(config) {
  try {
    return new URL("/monitor", config.targetUrl).toString();
  } catch {
    return config.targetUrl || "";
  }
}

function withRechargeRatio(channel, config) {
  const rechargeRatio = finiteNumber(config?.rechargeRatio) ?? 1;
  return {
    ...channel,
    listedBaseMultiplier: channel.baseMultiplier,
    listedUserMultiplier: channel.userMultiplier,
    listedPeakMultiplier: channel.peakMultiplier,
    listedEffectiveMultiplier: channel.effectiveMultiplier,
    rechargeRatio,
    baseMultiplier: dividedMultiplier(channel.baseMultiplier, rechargeRatio),
    userMultiplier: dividedMultiplier(channel.userMultiplier, rechargeRatio),
    peakMultiplier: dividedMultiplier(channel.peakMultiplier, rechargeRatio),
    effectiveMultiplier: dividedMultiplier(channel.effectiveMultiplier, rechargeRatio)
  };
}

export function parseSub2ApiChannels(
  config,
  monitorsPayload,
  availablePayload,
  ratesPayload = null,
  { now = new Date() } = {}
) {
  const groups = flattenAvailableGroups(availablePayload, ratesPayload, now);
  return monitorItems(monitorsPayload).map((monitor) => {
    const group = chooseGroup(monitor, groups);
    const observedModels = monitorModels(monitor);
    const nameMultiplier = multiplierFromName(monitor.name);
    const models = uniqueStrings(group?.supportedModels?.length
      ? group.supportedModels
      : observedModels.map((item) => item.model));
    return withRechargeRatio({
      providerId: config.id,
      providerName: config.name,
      monitorId: monitor.id ?? null,
      groupId: group?.id ?? null,
      name: monitor.name || group?.name || "未命名渠道",
      groupName: group?.name || monitor.group_name || "",
      categoryName: group?.categoryName || "",
      platform: monitor.provider || monitor.platform || group?.platform || "",
      models,
      observedModels,
      primaryModel: monitor.primary_model || observedModels[0]?.model || "",
      status: monitor.primary_status || "unknown",
      latencyMs: finiteNumber(monitor.primary_latency_ms),
      pingLatencyMs: finiteNumber(monitor.primary_ping_latency_ms),
      availability7d: finiteNumber(monitor.availability_7d),
      checkedAt: monitor.timeline?.[0]?.checked_at || null,
      timeline: monitorTimeline(monitor),
      baseMultiplier: group?.baseMultiplier ?? nameMultiplier,
      userMultiplier: group?.userMultiplier ?? null,
      peakMultiplier: group?.peakMultiplier ?? null,
      peakActive: group?.peakActive ?? false,
      effectiveMultiplier: group?.effectiveMultiplier ?? nameMultiplier,
      rateSource: group?.rateSource || (nameMultiplier != null ? "monitor-name" : "unknown"),
      matchConfidence: group?.matchConfidence || "monitor-name",
      monitorUrl: monitorUrl(config)
    }, config);
  });
}

export function parseEzaiclubChannels(
  config,
  monitorsPayload,
  groupsPayload,
  ratesPayload = null,
  options = {}
) {
  return parseSub2ApiChannels(config, monitorsPayload, groupsPayload, ratesPayload, options);
}

export function channelStatusForModel(channel, selectedModel = "") {
  const model = String(selectedModel || "");
  if (model && !(channel.models || []).includes(model)) return null;
  const observed = (channel.observedModels || []).find((item) => item.model === model);
  if (observed) {
    return { status: observed.status, latencyMs: observed.latencyMs, statusSource: "model" };
  }
  return {
    status: channel.status || "unknown",
    latencyMs: channel.latencyMs ?? null,
    statusSource: model ? "channel" : "primary"
  };
}

function providerBalanceAllowsUse(snapshot) {
  const numeric = (snapshot.balances || [])
    .filter((item) => ["balance", "total_balance"].includes(item.key))
    .map((item) => finiteNumber(item.value))
    .filter((value) => value != null);
  return !numeric.length || Math.max(...numeric) > 0;
}

export function availableChannelModels(snapshots) {
  return uniqueStrings((snapshots || []).flatMap((snapshot) => (
    (snapshot.channels || []).flatMap((channel) => channel.models || [])
  ))).sort((left, right) => left.localeCompare(right));
}

export function summarizeChannelRefresh(providers) {
  const snapshots = Array.isArray(providers) ? providers : [];
  return {
    providerCount: snapshots.length,
    channelCount: snapshots.reduce((count, snapshot) => count + (snapshot?.channels?.length || 0), 0),
    failedCount: snapshots.filter((snapshot) => (
      snapshot?.channelError
      || snapshot?.channelsStale === true
      || ["error", "stale", "needs_visit"].includes(snapshot?.status)
    )).length
  };
}

export function rankAvailableChannels(snapshots, selectedModel = "", { statuses = ["operational"] } = {}) {
  const allowedStatuses = new Set(statuses);
  const candidates = [];
  for (const snapshot of snapshots || []) {
    if (snapshot?.status !== "ok" || snapshot.channelsStale === true || !providerBalanceAllowsUse(snapshot)) continue;
    for (const channel of snapshot.channels || []) {
      const resolved = channelStatusForModel(channel, selectedModel);
      if (!resolved || !allowedStatuses.has(resolved.status) || !Number.isFinite(channel.effectiveMultiplier)) continue;
      candidates.push({
        ...channel,
        selectedModel: selectedModel || channel.primaryModel,
        resolvedStatus: resolved.status,
        resolvedLatencyMs: resolved.latencyMs,
        statusSource: resolved.statusSource,
        channelsStale: snapshot.channelsStale === true
      });
    }
  }
  return candidates.sort((left, right) => (
    left.effectiveMultiplier - right.effectiveMultiplier
    || Number(left.statusSource !== "model") - Number(right.statusSource !== "model")
    || (right.availability7d ?? -1) - (left.availability7d ?? -1)
    || (left.resolvedLatencyMs ?? Number.POSITIVE_INFINITY) - (right.resolvedLatencyMs ?? Number.POSITIVE_INFINITY)
    || left.providerName.localeCompare(right.providerName)
  ));
}
