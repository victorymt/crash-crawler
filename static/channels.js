let models = [];
let channels = [];
let summary = {};
let activeOperation = false;
let lastChannelLoadAt = 0;
let channelReloadPromise = null;
const requestJson = window.providerApi.requestJson;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", isError);
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, select, input").forEach((node) => {
    node.disabled = disabled && node.id !== "cancel-channel-refresh";
  });
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

function showRefreshProgress(job) {
  const progress = document.getElementById("channel-refresh-progress");
  progress.hidden = false;
  progress.max = Math.max(1, Number(job.total || 0));
  progress.value = Number(job.completed || 0);
  const active = (job.providers || []).filter((item) => item.status === "refreshing").map((item) => item.name);
  const current = active.length ? `正在刷新 ${active.slice(0, 2).join("、")}` : "正在准备浏览器";
  setMessage(`渠道刷新进度 ${job.completed || 0}/${job.total || 0} · ${current}`);
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
  setCancelVisible(true);
  setMessage("正在刷新支持渠道监控的 Provider...");
  try {
    const data = await requestJson("/api/refresh-channels", { method: "POST", timeout: 20000 });
    if (["running", "cancelling"].includes(data.refresh?.status)) {
      await monitorRefresh(data.refresh);
    } else {
      setMessage("渠道刷新任务未启动", true);
    }
  } catch (error) {
    setMessage(error.name === "AbortError" ? "刷新超时" : error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
  }
}

async function monitorRefresh(job) {
  setCancelVisible(["running", "cancelling"].includes(job?.status));
  while (["running", "cancelling"].includes(job?.status)) {
    showRefreshProgress(job);
    if (job.status === "cancelling") setMessage("正在取消渠道刷新...");
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    const data = await requestJson("/api/refresh-channels", { timeout: 20000 });
    job = data.refresh;
    if (!job) throw new Error("渠道刷新任务状态已丢失");
  }
  await loadChannels();
  setCancelVisible(false);
  const failures = Number(job.failureCount || 0);
  setRetryVisible(failures > 0);
  if (job.status === "cancelled") {
    setMessage(`渠道刷新已取消：完成 ${job.completed}/${job.total}`);
  } else if (job.status === "interrupted" || job.status === "failed") {
    setMessage(`渠道刷新中断：${job.error || "后台任务失败"}`, true);
  } else if (failures) {
    setMessage(`渠道刷新完成：成功 ${job.successCount}，失败 ${failures}`, true);
  } else {
    setMessage(`渠道刷新完成：${job.completed}/${job.total}`);
  }
}

async function retryFailedChannels() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setRetryVisible(false);
  setMessage("正在创建渠道失败项重试任务...");
  try {
    const data = await requestJson("/api/refresh-channels/retry", { method: "POST", timeout: 20000 });
    if (!data.started) {
      setMessage("当前没有可重试的失败渠道 Provider");
      return;
    }
    setCancelVisible(true);
    await monitorRefresh(data.refresh);
  } catch (error) {
    setMessage(error.name === "AbortError" ? "读取重试进度超时" : error.message || "重试失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
  }
}

async function cancelRefresh() {
  if (!activeOperation) return;
  const button = document.getElementById("cancel-channel-refresh");
  button.disabled = true;
  try {
    const data = await requestJson("/api/refresh-channels/cancel", { method: "POST", timeout: 20000 });
    if (data.cancelled) setMessage("正在取消渠道刷新...");
  } catch (error) {
    button.disabled = false;
    setMessage(error.message || "取消渠道刷新失败", true);
  }
}

async function initialize() {
  await loadChannels();
  const data = await requestJson("/api/refresh-channels", { timeout: 20000 });
  if (!["running", "cancelling"].includes(data.refresh?.status)) {
    setRetryVisible(Number(data.refresh?.failureCount || 0) > 0);
    if (data.refresh?.status === "interrupted") {
      setMessage(`上次渠道刷新中断：${data.refresh.error || "服务重启导致任务中断"}`, true);
    }
    return;
  }
  activeOperation = true;
  setControlsDisabled(true);
  setCancelVisible(true);
  try {
    await monitorRefresh(data.refresh);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
  }
}

document.getElementById("channel-model").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("include-degraded").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("refresh-channels").addEventListener("click", refreshChannels);
document.getElementById("retry-channel-failed").addEventListener("click", retryFailedChannels);
document.getElementById("cancel-channel-refresh").addEventListener("click", cancelRefresh);
window.providerConfigEvents?.subscribe(() => reloadChannelsIfVisible(true));
window.addEventListener("focus", () => reloadChannelsIfVisible());
document.addEventListener("visibilitychange", () => reloadChannelsIfVisible());
initialize().catch((error) => setMessage(error.message || "读取渠道失败", true));
