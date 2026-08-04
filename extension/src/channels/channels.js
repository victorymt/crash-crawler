import { availableChannelModels, rankAvailableChannels } from "../shared/channels.js";
import { snapshotNeedsRetry } from "../shared/snapshots.js";

let snapshots = [];
let settings = {};
let activeOperation = false;
let failedChannelRunCount = 0;

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
  document.getElementById("include-degraded").disabled = disabled;
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
  return Number.isFinite(value) ? `${Number(value.toFixed(4))}x` : "--";
}

function statusLabel(status) {
  return ({ operational: "可用", degraded: "降级", error: "故障" })[status] || status || "未知";
}

function rateSourceLabel(channel) {
  if (Number(channel.rechargeRatio) > 1) return "充值折算";
  if (channel.rateSource === "peak") return "峰时倍率";
  if (channel.rateSource === "user") return "个人倍率";
  if (channel.rateSource === "monitor-name") return "监控倍率";
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
  const className = `channel-row${index === 0 ? " best" : ""}`;
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

function render() {
  const modelSelect = document.getElementById("channel-model");
  const resultRoot = document.getElementById("channel-results");
  const models = availableChannelModels(snapshots);
  const selectedModel = models.includes(settings.preferredChannelModel) ? settings.preferredChannelModel : "";
  modelSelect.innerHTML = [
    '<option value="">全部模型</option>',
    ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
  ].join("");
  modelSelect.value = selectedModel;

  const includeDegraded = document.getElementById("include-degraded").checked;
  const statuses = includeDegraded ? ["operational", "degraded"] : ["operational"];
  const candidates = rankAvailableChannels(snapshots, selectedModel, { statuses });
  const channelCount = snapshots.reduce((count, snapshot) => count + (snapshot.channels?.length || 0), 0);
  const channelErrors = snapshots.filter((snapshot) => snapshot.channelError).length;
  document.getElementById("channel-meta").textContent = channelErrors
    ? `${candidates.length} 个候选 · ${channelErrors} 个 Provider 刷新失败`
    : `${candidates.length} 个候选 · ${channelCount} 个监控渠道`;
  document.getElementById("updated-at").textContent = `渠道更新 ${latestChannelCheck()}`;

  resultRoot.innerHTML = candidates.length
    ? candidates.map(channelRowHtml).join("")
    : '<div class="empty">当前没有可用渠道</div>';
  setControlsDisabled(activeOperation);
  setRetryVisible(hasFailedChannelSnapshots() || failedChannelRunCount > 0);
}

async function loadStatus() {
  const data = await sendMessage({ type: "providers:list" });
  snapshots = data.providers || [];
  settings = data.settings || {};
  render();
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

document.getElementById("include-degraded").addEventListener("change", render);
document.getElementById("refresh-channels").addEventListener("click", refreshChannels);
document.getElementById("retry-channel-failed").addEventListener("click", retryFailedChannels);
document.getElementById("cancel-channel-refresh").addEventListener("click", cancelRefresh);
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || activeOperation) return;
    if (changes.providerSnapshots) loadStatus().catch((error) => setMessage(error.message, true));
  });
}

initialize().catch((error) => setMessage(error.message, true));
