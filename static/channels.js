let models = [];
let channels = [];
let summary = {};
let activeOperation = false;
let lastChannelLoadAt = 0;
let channelReloadPromise = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 180000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", isError);
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, select, input").forEach((node) => { node.disabled = disabled; });
}

function statusLabel(status) {
  return ({ operational: "可用", degraded: "降级", error: "故障" })[status] || status || "未知";
}

function formatMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Number(number.toFixed(4))}x` : "--";
}

function rateSourceLabel(channel) {
  if (Number(channel.rechargeRatio) !== 1) return `充值折算 1:${Number(channel.rechargeRatio)}`;
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
  return `<span class="status-timeline" role="img" aria-label="最近 ${points.length} 次渠道状态">${points.map((point) => (
    `<span class="timeline-point ${escapeHtml(point.status)}" title="${escapeHtml(timelinePointTitle(point))}"></span>`
  )).join("")}</span>`;
}

function channelRowHtml(channel, index) {
  const latency = Number.isFinite(channel.resolvedLatencyMs) ? `${channel.resolvedLatencyMs} ms` : "--";
  const availability = Number.isFinite(channel.availability7d) ? `${channel.availability7d.toFixed(1)}%` : "--";
  const statusSource = channel.statusSource === "model" ? "模型实测" : "渠道状态";
  const body = `<span class="rank">${index + 1}</span>
    <span class="identity">
      <strong>${escapeHtml(channel.name)}</strong>
      <small>${escapeHtml(channel.providerName)} · ${escapeHtml(channel.selectedModel || channel.primaryModel || "全部模型")}</small>
    </span>
    <span class="health">
      <span class="health-summary">
        <strong class="channel-status ${escapeHtml(channel.resolvedStatus)}">${escapeHtml(statusLabel(channel.resolvedStatus))}</strong>
        ${statusTimelineHtml(channel)}
      </span>
      <small>${escapeHtml(statusSource)} · ${escapeHtml(latency)} · 7 天 ${escapeHtml(availability)}</small>
    </span>
    <span class="rate"><strong>${escapeHtml(formatMultiplier(channel.effectiveMultiplier))}</strong><small>${escapeHtml(rateSourceLabel(channel))}</small></span>`;
  const className = `channel-row${index === 0 ? " best" : ""}`;
  return channel.monitorUrl
    ? `<a class="${className}" href="${escapeHtml(channel.monitorUrl)}" target="_blank" rel="noopener noreferrer">${body}</a>`
    : `<div class="${className}">${body}</div>`;
}

function render() {
  const select = document.getElementById("channel-model");
  const selected = select.value;
  select.innerHTML = [
    '<option value="">全部模型</option>',
    ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
  ].join("");
  select.value = models.includes(selected) ? selected : "";
  document.getElementById("channel-results").innerHTML = channels.length
    ? channels.map(channelRowHtml).join("")
    : '<div class="empty">当前没有符合筛选条件的可用渠道</div>';
  const failed = Number(summary.failedCount) || 0;
  const countText = `${channels.length} 个候选 · ${Number(summary.channelCount) || 0} 个监控渠道`;
  document.getElementById("channel-meta").textContent = failed ? `${countText} · ${failed} 个 Provider 异常` : countText;
  const latestCheckedAt = Date.parse(summary.latestCheckedAt || "");
  document.getElementById("updated-at").textContent = Number.isFinite(latestCheckedAt)
    ? `最近检查 ${new Date(latestCheckedAt).toLocaleString()}`
    : "尚无检查记录";
  setControlsDisabled(activeOperation);
}

async function loadChannels() {
  const model = document.getElementById("channel-model").value;
  const degraded = document.getElementById("include-degraded").checked;
  const query = new URLSearchParams();
  if (model) query.set("model", model);
  if (degraded) query.set("include_degraded", "1");
  const data = await requestJson(`/api/channels?${query}`);
  models = data.models || [];
  channels = data.channels || [];
  summary = data.summary || {};
  lastChannelLoadAt = Date.now();
  render();
}

function reloadChannelsIfVisible(force = false) {
  if (activeOperation || document.visibilityState === "hidden" || channelReloadPromise) return;
  if (!force && Date.now() - lastChannelLoadAt < 1000) return;
  channelReloadPromise = loadChannels()
    .catch((error) => setMessage(error.message || "读取渠道失败", true))
    .finally(() => { channelReloadPromise = null; });
}

async function refreshChannels() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setMessage("正在刷新支持渠道监控的 Provider...");
  try {
    const data = await requestJson("/api/refresh-channels", { method: "POST" });
    await loadChannels();
    const result = data.summary || {};
    const failed = Number(result.failedCount) || 0;
    setMessage(`已刷新 ${Number(result.providerCount) || 0} 个 Provider · ${Number(result.channelCount) || 0} 个渠道 · ${failed} 个异常`, failed > 0);
  } catch (error) {
    setMessage(error.name === "AbortError" ? "刷新超时" : error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

document.getElementById("channel-model").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("include-degraded").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("refresh-channels").addEventListener("click", refreshChannels);
window.providerConfigEvents?.subscribe(() => reloadChannelsIfVisible(true));
window.addEventListener("focus", () => reloadChannelsIfVisible());
document.addEventListener("visibilitychange", () => reloadChannelsIfVisible());
loadChannels().catch((error) => setMessage(error.message || "读取渠道失败", true));
