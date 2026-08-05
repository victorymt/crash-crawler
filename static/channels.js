let models = [];
let channels = [];
let summary = {};
let providers = [];
let activeOperation = false;
let lastChannelLoadAt = 0;
let channelReloadPromise = null;
const pendingProviderIds = new Set();
let pendingProviderRetryPromise = null;
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
  const number = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(number) ? `${Number(number.toFixed(4))}x` : "--";
}

function rateSourceLabel(channel) {
  if (Number(channel.rechargeRatio) !== 1) return `充值折算 1:${Number(channel.rechargeRatio)}`;
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
  const hasRate = channel.effectiveMultiplier != null
    && channel.effectiveMultiplier !== ""
    && Number.isFinite(Number(channel.effectiveMultiplier));
  const className = `channel-row${index === 0 && hasRate ? " best" : ""}`;
  return channel.monitorUrl
    ? `<a class="${className}" href="${escapeHtml(channel.monitorUrl)}" target="_blank" rel="noopener noreferrer">${body}</a>`
    : `<div class="${className}">${body}</div>`;
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

function renderProviderHealth() {
  const root = document.getElementById("channel-provider-health");
  const issues = providers.filter((provider) => {
    const state = providerHealthState(provider);
    return state.tone !== "ok";
  });
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
  const select = document.getElementById("channel-model");
  const selected = select.value;
  select.innerHTML = [
    '<option value="">全部模型</option>',
    ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
  ].join("");
  select.value = models.includes(selected) ? selected : "";
  const statusSelect = document.getElementById("channel-status");
  const availabilitySelect = document.getElementById("channel-availability");
  const rateSelect = document.getElementById("channel-rate");
  const providerSelect = document.getElementById("channel-provider");
  const selectedStatus = statusSelect.value;
  const selectedAvailability = availabilitySelect.value || "all";
  const selectedRate = rateSelect.value || "all";
  const selectedProvider = providerSelect.value;
  providerSelect.innerHTML = [
    '<option value="">全部 Provider</option>',
    ...providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`)
  ].join("");
  providerSelect.value = providers.some((provider) => String(provider.id) === String(selectedProvider)) ? selectedProvider : "";
  renderProviderHealth();
  document.getElementById("channel-results").innerHTML = channels.length
    ? channels.map(channelRowHtml).join("")
    : '<div class="empty">当前没有符合筛选条件的渠道</div>';
  const failed = Number(summary.failedCount) || 0;
  const details = [
    `${channels.length} 个渠道`,
    `${Number(summary.channelCount) || 0} 个监控渠道`,
    Number(summary.unrankedCount) ? `${Number(summary.unrankedCount)} 个渠道倍率未识别` : "",
    failed ? `${failed} 个 Provider 异常` : ""
  ].filter(Boolean);
  document.getElementById("channel-meta").textContent = details.join(" · ");
  const latestCheckedAt = Date.parse(summary.latestCheckedAt || "");
  document.getElementById("updated-at").textContent = Number.isFinite(latestCheckedAt)
    ? `最近检查 ${new Date(latestCheckedAt).toLocaleString()}`
    : "尚无检查记录";
  setControlsDisabled(activeOperation);
}

async function loadChannels() {
  const model = document.getElementById("channel-model").value;
  const status = document.getElementById("channel-status").value;
  const rate = document.getElementById("channel-rate").value || "all";
  const provider = document.getElementById("channel-provider").value;
  const availability = document.getElementById("channel-availability").value || "all";
  const query = new URLSearchParams();
  if (model) query.set("model", model);
  if (status) query.set("status", status);
  if (rate !== "all") query.set("rate", rate);
  if (availability !== "all") query.set("availability", availability);
  if (provider) query.set("provider", provider);
  const data = await requestJson(`/api/channels?${query}`);
  models = data.models || [];
  channels = data.channels || [];
  providers = data.providers || [];
  summary = data.summary || {};
  lastChannelLoadAt = Date.now();
  render();
}

function queueProviderRetry(providerId) {
  const normalized = String(providerId || "").trim();
  if (normalized) pendingProviderIds.add(normalized);
}

function providerNeedsRetryAfterLogin(providerId) {
  const provider = providers.find((item) => String(item.id) === String(providerId));
  return !provider
    || ["needs_login", "needs_visit", "stale", "error"].includes(provider.status)
    || Boolean(provider.error)
    || provider.channelsStale === true;
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
    setMessage("登录已返回，正在同步登录态并重新采集 Provider...");
    let refreshed = 0;
    try {
      await requestJson("/api/sync-auth", { method: "POST", timeout: 120000 });
      for (const providerId of providerIds) {
        await requestJson(
          `/api/providers/${encodeURIComponent(providerId)}/refresh`,
          { method: "POST", timeout: 120000 }
        );
        refreshed += 1;
      }
      await loadChannels();
      const stillPending = providerIds.filter(providerNeedsRetryAfterLogin);
      stillPending.forEach(queueProviderRetry);
      if (stillPending.length) {
        setMessage(`已重新采集 ${refreshed} 个 Provider，${stillPending.length} 个仍需登录或重试`, true);
      } else {
        setMessage(`登录后已重新采集 ${refreshed} 个 Provider`);
      }
    } catch (error) {
      providerIds.forEach(queueProviderRetry);
      await loadChannels().catch(() => undefined);
      setMessage(error.message || "登录后重新采集失败", true);
    } finally {
      activeOperation = false;
      setControlsDisabled(false);
      setRetryVisible(Number(summary.failedCount || 0) > 0);
    }
  })().finally(() => {
    pendingProviderRetryPromise = null;
  });
  await pendingProviderRetryPromise;
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
document.getElementById("channel-status").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("channel-availability").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("channel-rate").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("channel-provider").addEventListener("change", () => loadChannels().catch((error) => setMessage(error.message, true)));
document.getElementById("refresh-channels").addEventListener("click", refreshChannels);
document.getElementById("retry-channel-failed").addEventListener("click", retryFailedChannels);
document.getElementById("cancel-channel-refresh").addEventListener("click", cancelRefresh);
document.getElementById("channel-provider-health").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-provider-id]");
  if (link) queueProviderRetry(link.dataset.providerId);
});
window.providerConfigEvents?.subscribe(() => reloadChannelsIfVisible(true));
function reloadAfterProviderLogin() {
  if (document.visibilityState !== "hidden") {
    window.setTimeout(() => {
      retryPendingProviders().catch((error) => setMessage(error.message, true));
      reloadChannelsIfVisible();
    }, 0);
  }
}
window.addEventListener("focus", reloadAfterProviderLogin);
document.addEventListener("visibilitychange", reloadAfterProviderLogin);
initialize().catch((error) => setMessage(error.message || "读取渠道失败", true));
