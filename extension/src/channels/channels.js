import { availableChannelModels, listChannels } from "../shared/channels.js";
import {
  PROVIDER_CAPABILITIES,
  providerSupportsCapability
} from "../shared/provider_definitions.js";
import { snapshotNeedsRetry } from "../shared/snapshots.js";

let snapshots = [];
let settings = {};
let activeOperation = false;
let failedChannelRunCount = 0;
const pendingProviderIds = new Set();
let pendingProviderRetryPromise = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(isError));
}

function setControlsDisabled(disabled) {
  document.getElementById("refresh-channels").disabled = disabled;
  document.getElementById("channel-model").disabled = disabled;
  document.getElementById("channel-status").disabled = disabled;
  document.getElementById("channel-availability").disabled = disabled;
  document.getElementById("channel-rate").disabled = disabled;
  document.getElementById("channel-provider").disabled = disabled;
  document.getElementById("options").disabled = disabled;
  document.getElementById("retry-channel-failed").disabled = disabled;
}

function setCancelVisible(visible) {
  const button = document.getElementById("cancel-channel-refresh");
  button.hidden = !visible;
  button.disabled = !visible;
}

function setRetryVisible(visible) {
  const button = document.getElementById("retry-channel-failed");
  button.hidden = !visible;
  button.disabled = !visible || activeOperation;
}

function hasFailedChannelSnapshots() {
  return snapshots.some((snapshot) => snapshotNeedsRetry(snapshot, { channelsOnly: true }));
}

function isChannelRun(run) {
  return ["manual-channels", "manual-channels-retry"].includes(run?.trigger);
}

function failedRunCount(run) {
  return Object.values(run?.providers || {}).filter((state) => (
    state.snapshotStatus && state.snapshotStatus !== "ok"
  )).length;
}

function showRefreshProgress(run) {
  const progress = document.getElementById("channel-refresh-progress");
  const states = Object.entries(run?.providers || {});
  const completed = states.filter(([, state]) => ["complete", "cancelled"].includes(state.state)).length;
  const active = states.find(([, state]) => state.state === "running");
  progress.hidden = false;
  progress.max = Math.max(1, states.length);
  progress.value = completed;
  const current = active
    ? ` · ${active[0]}${active[1].currentStep ? ` (${active[1].currentStep})` : ""}`
    : "";
  setMessage(`渠道刷新进度 ${completed}/${states.length}${current}`);
}

function formatMultiplier(value) {
  const number = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(number) ? `${Number(number.toFixed(4))}x` : "--";
}

function statusLabel(status) {
  return ({ operational: "可用", degraded: "降级", error: "故障" })[status] || status || "未知";
}

function rateSourceLabel(channel) {
  if (Number(channel.rechargeRatio) > 1) return "充值折算";
  if (channel.rateSource === "peak") return "峰时倍率";
  if (channel.rateSource === "user") return "个人倍率";
  if (channel.rateSource === "monitor-name") return "监控倍率";
  if (channel.rateSource === "unknown") return "未识别倍率";
  return "分组倍率";
}

function timelinePointTitle(point) {
  const time = point.checkedAt ? new Date(point.checkedAt).toLocaleString() : "时间未知";
  const latency = Number.isFinite(point.latencyMs) ? ` · ${point.latencyMs} ms` : "";
  return `${time} · ${statusLabel(point.status)}${latency}`;
}

function statusTimelineHtml(channel) {
  const points = Array.isArray(channel.timeline) ? channel.timeline.slice(0, 30).reverse() : [];
  if (!points.length) return '<span class="timeline-empty">暂无近期记录</span>';
  const bars = points.map((point) => (
    `<span class="timeline-point ${escapeHtml(point.status)}" title="${escapeHtml(timelinePointTitle(point))}"></span>`
  )).join("");
  return `<span class="status-timeline" role="img" aria-label="最近 ${points.length} 次渠道状态">${bars}</span>`;
}

function channelRowHtml(channel, index) {
  const latency = Number.isFinite(channel.resolvedLatencyMs) ? `${channel.resolvedLatencyMs} ms` : "--";
  const availability = Number.isFinite(channel.availability7d) ? `${channel.availability7d.toFixed(1)}%` : "--";
  const statusSource = channel.statusSource === "model" ? "模型实测" : "渠道状态";
  const content = `<span class="rank">${index + 1}</span>
    <span class="identity">
      <strong>${escapeHtml(channel.name)}</strong>
      <small>${escapeHtml(channel.providerName)} · ${escapeHtml(channel.selectedModel || channel.primaryModel)}</small>
    </span>
    <span class="health">
      <span class="health-summary">
        <strong class="channel-status ${escapeHtml(channel.resolvedStatus)}">${escapeHtml(statusLabel(channel.resolvedStatus))}</strong>
        ${statusTimelineHtml(channel)}
      </span>
      <small>${escapeHtml(statusSource)} · ${escapeHtml(latency)} · 7 天 ${escapeHtml(availability)}</small>
    </span>
    <span class="rate">
      <strong>${escapeHtml(formatMultiplier(channel.effectiveMultiplier))}</strong>
      <small>${escapeHtml(rateSourceLabel(channel))}</small>
    </span>`;
  const hasRate = channel.effectiveMultiplier != null
    && channel.effectiveMultiplier !== ""
    && Number.isFinite(Number(channel.effectiveMultiplier));
  const className = `channel-row${index === 0 && hasRate ? " best" : ""}`;
  return channel.monitorUrl
    ? `<a class="${className}" href="${escapeHtml(channel.monitorUrl)}" target="_blank" rel="noopener noreferrer">${content}</a>`
    : `<div class="${className}">${content}</div>`;
}

function latestChannelCheck() {
  const timestamps = snapshots
    .map((snapshot) => Date.parse(snapshot.channelCheckedAt || ""))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toLocaleString() : "--";
}

function providerHealthState(provider) {
  if (provider.status === "needs_login") return { label: "需要登录", tone: "needs-login" };
  if (provider.status === "needs_visit") return { label: "需要访问", tone: "warning" };
  if (provider.channelsStale || provider.status === "stale") return { label: "使用旧数据", tone: "warning" };
  if (provider.error || provider.status === "error") return { label: "采集失败", tone: "error" };
  if (provider.status === "idle") return { label: "尚未刷新", tone: "idle" };
  if (!Number(provider.channelCount)) return { label: "暂无渠道", tone: "idle" };
  return { label: "正常", tone: "ok" };
}

function providerHealthRows() {
  return snapshots
    .filter((snapshot) => providerSupportsCapability(
      snapshot.type,
      PROVIDER_CAPABILITIES.CHANNELS
    ))
    .map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.name || snapshot.id,
      url: snapshot.url || "",
      status: snapshot.status || "unknown",
      error: snapshot.error || snapshot.channelError || "",
      channelCount: (snapshot.channels || []).length,
      channelCheckedAt: snapshot.channelCheckedAt || null,
      channelsStale: snapshot.channelsStale === true
    }));
}

function renderProviderHealth(providers) {
  const root = document.getElementById("channel-provider-health");
  const issues = providers.filter((provider) => providerHealthState(provider).tone !== "ok");
  root.hidden = issues.length === 0;
  root.innerHTML = issues.map((provider) => {
    const state = providerHealthState(provider);
    const checkedAt = Date.parse(provider.channelCheckedAt || "");
    const fallback = Number.isFinite(checkedAt)
      ? `上次成功 ${new Date(checkedAt).toLocaleString()}`
      : "尚无成功记录";
    const detail = String(provider.error || fallback).slice(0, 180);
    const content = `<strong>${escapeHtml(provider.name)}</strong><span class="provider-health-status ${state.tone}">${escapeHtml(state.label)}</span><small>${escapeHtml(detail)}</small>`;
    return provider.url
      ? `<a href="${escapeHtml(provider.url)}" data-provider-id="${escapeHtml(provider.id)}" target="_blank" rel="noopener noreferrer">${content}</a>`
      : `<div>${content}</div>`;
  }).join("");
}

function render() {
  const modelSelect = document.getElementById("channel-model");
  const resultRoot = document.getElementById("channel-results");
  const models = availableChannelModels(snapshots);
  const statusSelect = document.getElementById("channel-status");
  const availabilitySelect = document.getElementById("channel-availability");
  const rateSelect = document.getElementById("channel-rate");
  const providerSelect = document.getElementById("channel-provider");
  const selectedStatus = statusSelect.value;
  const selectedAvailability = availabilitySelect.value || "all";
  const selectedRate = rateSelect.value || "all";
  const selectedProvider = providerSelect.value;
  const selectedModel = models.includes(settings.preferredChannelModel) ? settings.preferredChannelModel : "";
  modelSelect.innerHTML = [
    '<option value="">全部模型</option>',
    ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
  ].join("");
  modelSelect.value = selectedModel;
  const providers = providerHealthRows().sort((left, right) => left.name.localeCompare(right.name));
  providerSelect.innerHTML = [
    '<option value="">全部 Provider</option>',
    ...providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`)
  ].join("");
  providerSelect.value = providers.some((provider) => String(provider.id) === String(selectedProvider)) ? selectedProvider : "";
  renderProviderHealth(providers);
  const candidates = listChannels(snapshots, selectedModel, {
    statuses: selectedStatus ? [selectedStatus] : null,
    availabilityOnly: selectedAvailability === "available",
    rateMode: selectedRate,
    providerId: providerSelect.value
  });
  const channelCount = snapshots.reduce((count, snapshot) => count + (snapshot.channels?.length || 0), 0);
  const unrankedCount = snapshots.reduce((count, snapshot) => count + (snapshot.channels || []).filter(
    (channel) => channel?.effectiveMultiplier == null
      || channel.effectiveMultiplier === ""
      || !Number.isFinite(Number(channel.effectiveMultiplier))
  ).length, 0);
  const channelErrors = snapshots.filter((snapshot) => snapshot.channelError).length;
  const details = [
    `${candidates.length} 个候选`,
    `${channelCount} 个监控渠道`,
    unrankedCount ? `${unrankedCount} 个渠道倍率未识别` : "",
    channelErrors ? `${channelErrors} 个 Provider 刷新失败` : ""
  ].filter(Boolean);
  document.getElementById("channel-meta").textContent = details.join(" · ");
  document.getElementById("updated-at").textContent = `渠道更新 ${latestChannelCheck()}`;

  resultRoot.innerHTML = candidates.length
    ? candidates.map(channelRowHtml).join("")
    : '<div class="empty">当前没有符合筛选条件的渠道</div>';
  setControlsDisabled(activeOperation);
  setRetryVisible(hasFailedChannelSnapshots() || failedChannelRunCount > 0);
}

async function loadStatus() {
  const data = await sendMessage({ type: "providers:list" });
  snapshots = data.providers || [];
  settings = data.settings || {};
  render();
}

function queueProviderRetry(providerId) {
  const normalized = String(providerId || "").trim();
  if (normalized) pendingProviderIds.add(normalized);
}

async function retryPendingProviders() {
  if (
    !pendingProviderIds.size
    || activeOperation
    || document.visibilityState === "hidden"
    || pendingProviderRetryPromise
  ) return;

  const providerIds = [...pendingProviderIds];
  pendingProviderIds.clear();
  pendingProviderRetryPromise = (async () => {
    activeOperation = true;
    setControlsDisabled(true);
    setRetryVisible(false);
    setMessage("登录已返回，正在重新采集 Provider...");
    let refreshed = 0;
    try {
      for (const providerId of providerIds) {
        await sendMessage({ type: "providers:refresh", providerId });
        refreshed += 1;
      }
      await loadStatus();
      const stillPending = providerIds.filter((providerId) => {
        const snapshot = snapshots.find((item) => String(item.id) === String(providerId));
        return !snapshot || snapshotNeedsRetry(snapshot, { channelsOnly: true });
      });
      stillPending.forEach(queueProviderRetry);
      if (stillPending.length) {
        setMessage(`已重新采集 ${refreshed} 个 Provider，${stillPending.length} 个仍需登录或重试`, true);
      } else {
        setMessage(`登录后已重新采集 ${refreshed} 个 Provider`);
      }
    } catch (error) {
      providerIds.forEach(queueProviderRetry);
      await loadStatus().catch(() => undefined);
      setMessage(error.message || "登录后重新采集失败", true);
    } finally {
      activeOperation = false;
      setControlsDisabled(false);
      setRetryVisible(hasFailedChannelSnapshots() || failedChannelRunCount > 0);
    }
  })().finally(() => {
    pendingProviderRetryPromise = null;
  });
  await pendingProviderRetryPromise;
}

async function pollChannelRunUntilRequestSettles(request) {
  let settled = false;
  const observed = request.then(
    (value) => ({ value }),
    (error) => ({ error })
  ).finally(() => { settled = true; });

  while (!settled) {
    const data = await sendMessage({ type: "providers:refreshStatus" });
    const run = data.refresh;
    if (isChannelRun(run) && run.state === "running") {
      showRefreshProgress(run);
      setCancelVisible(true);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 600));
  }

  const result = await observed;
  if (result.error) throw result.error;
  return result.value;
}

function completedMessage(data, actionLabel) {
  const summary = data.summary || {};
  const providerCount = Number(summary.providerCount) || 0;
  const channelCount = Number(summary.channelCount) || 0;
  const failedCount = Number(summary.failedCount) || 0;
  failedChannelRunCount = failedCount;
  if (data.cancelled) return { text: `${actionLabel}已取消`, error: false };
  if (data.started === false) return { text: "当前没有可重试的失败渠道 Provider", error: false };
  return {
    text: `${actionLabel}完成：${providerCount} 个 Provider · ${channelCount} 个渠道 · ${failedCount} 个失败`,
    error: failedCount > 0
  };
}

async function runChannelRefresh(messageType, actionLabel) {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setRetryVisible(false);
  setCancelVisible(false);
  setMessage(`${actionLabel}中...`);
  try {
    const data = await pollChannelRunUntilRequestSettles(sendMessage({ type: messageType }));
    snapshots = data.providers || [];
    await loadStatus();
    const message = completedMessage(data, actionLabel);
    setMessage(message.text, message.error);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || `${actionLabel}失败`, true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
    setRetryVisible(hasFailedChannelSnapshots() || failedChannelRunCount > 0);
  }
}

function refreshChannels() {
  return runChannelRefresh("providers:refreshChannels", "渠道刷新");
}

function retryFailedChannels() {
  return runChannelRefresh("providers:refreshFailedChannels", "失败渠道重试");
}

async function cancelRefresh() {
  if (!activeOperation) return;
  const button = document.getElementById("cancel-channel-refresh");
  button.disabled = true;
  try {
    const data = await sendMessage({ type: "providers:cancelRefresh" });
    setMessage(data.cancelled ? "正在取消渠道刷新..." : "当前没有运行中的渠道刷新任务");
  } catch (error) {
    button.disabled = false;
    setMessage(error.message || "取消渠道刷新失败", true);
  }
}

async function monitorRestoredChannelRun(run) {
  activeOperation = true;
  setControlsDisabled(true);
  setCancelVisible(true);
  try {
    while (isChannelRun(run) && run.state === "running") {
      showRefreshProgress(run);
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      const data = await sendMessage({ type: "providers:refreshStatus" });
      run = data.refresh;
    }
    await loadStatus();
    const failures = failedRunCount(run);
    failedChannelRunCount = failures;
    if (run?.state === "cancelled") {
      setMessage("渠道刷新已取消");
    } else if (run?.state === "interrupted") {
      setMessage("上次渠道刷新已中断", true);
    } else if (failures) {
      setMessage(`渠道刷新完成：${failures} 个 Provider 需要重试`, true);
    } else if (run?.state === "complete") {
      setMessage("渠道刷新完成");
    }
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
    setRetryVisible(hasFailedChannelSnapshots() || failedRunCount(run) > 0);
  }
}

async function initialize() {
  await loadStatus();
  const data = await sendMessage({ type: "providers:refreshStatus" });
  const run = data.refresh;
  failedChannelRunCount = isChannelRun(run) ? failedRunCount(run) : 0;
  if (isChannelRun(run) && run.state === "running") {
    await monitorRestoredChannelRun(run);
    return;
  }
  if (isChannelRun(run) && run.state === "interrupted") {
    setMessage("上次渠道刷新已中断", true);
  }
  setRetryVisible(hasFailedChannelSnapshots() || (isChannelRun(run) && failedRunCount(run) > 0));
}

document.getElementById("channel-model").addEventListener("change", async (event) => {
  const previous = settings.preferredChannelModel || "";
  settings = { ...settings, preferredChannelModel: event.target.value };
  render();
  try {
    const data = await sendMessage({ type: "settings:save", settings: { preferredChannelModel: event.target.value } });
    settings = data.settings || settings;
  } catch (error) {
    settings = { ...settings, preferredChannelModel: previous };
    render();
    setMessage(error.message || "模型偏好保存失败", true);
  }
});

document.getElementById("channel-status").addEventListener("change", render);
document.getElementById("channel-availability").addEventListener("change", render);
document.getElementById("channel-rate").addEventListener("change", render);
document.getElementById("channel-provider").addEventListener("change", render);
document.getElementById("refresh-channels").addEventListener("click", refreshChannels);
document.getElementById("retry-channel-failed").addEventListener("click", retryFailedChannels);
document.getElementById("cancel-channel-refresh").addEventListener("click", cancelRefresh);
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("channel-provider-health").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-provider-id]");
  if (link) queueProviderRetry(link.dataset.providerId);
});

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || activeOperation) return;
    if (changes.providerSnapshots) loadStatus().catch((error) => setMessage(error.message, true));
  });
}

function retryQueuedProviderOnReturn() {
  if (document.visibilityState !== "hidden") {
    window.setTimeout(() => retryPendingProviders().catch((error) => setMessage(error.message, true)), 0);
  }
}

window.addEventListener("focus", retryQueuedProviderOnReturn);
document.addEventListener("visibilitychange", retryQueuedProviderOnReturn);

initialize().catch((error) => setMessage(error.message, true));
