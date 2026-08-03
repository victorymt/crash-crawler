import { availableChannelModels, rankAvailableChannels } from "../shared/channels.js";

let snapshots = [];
let settings = {};
let activeOperation = false;

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
}

async function loadStatus() {
  const data = await sendMessage({ type: "providers:list" });
  snapshots = data.providers || [];
  settings = data.settings || {};
  render();
}

async function refreshChannels() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setMessage("正在刷新渠道...");
  try {
    const data = await sendMessage({ type: "providers:refreshChannels" });
    snapshots = data.providers || [];
    render();
    const summary = data.summary || {};
    const providerCount = Number(summary.providerCount) || 0;
    const channelCount = Number(summary.channelCount) || 0;
    const failedCount = Number(summary.failedCount) || 0;
    setMessage(`已刷新 ${providerCount} 个 Provider · ${channelCount} 个渠道 · ${failedCount} 个失败`, failedCount > 0);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
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
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || activeOperation) return;
    if (changes.providerSnapshots) loadStatus().catch((error) => setMessage(error.message, true));
  });
}

loadStatus().catch((error) => setMessage(error.message, true));
