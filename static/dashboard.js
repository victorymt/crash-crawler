let providers = [];
let snapshots = [];
let activeOperation = false;
let lastStatusLoadAt = 0;
let statusReloadPromise = null;

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

function statusLabel(value) {
  return ({ ok: "正常", stale: "已过期", error: "失败", idle: "未刷新", unconfigured: "未配置" })[value] || value || "未刷新";
}

function recommendationLabel(value) {
  return ({ ok: "余额正常", watch: "需要关注", recharge: "建议充值" })[value] || "需要关注";
}

function formatMetric(metric) {
  const amount = metric.currency ? `${metric.value} ${metric.currency}` : metric.value;
  return `<span class="metric-chip"><small>${escapeHtml(metric.label)}</small><strong>${escapeHtml(amount ?? "--")}</strong></span>`;
}

function providerRow(config) {
  const snapshot = snapshots.find((item) => item.id === config.id) || {};
  const balances = snapshot.balances || [];
  const balanceKeys = new Set(balances.map((item) => `${item.key}|${item.label}|${item.value}`));
  const details = (snapshot.usage?.length ? snapshot.usage : (snapshot.metrics || []).filter((item) => (
    !balanceKeys.has(`${item.key}|${item.label}|${item.value}`)
  ))).slice(0, 4);
  const links = snapshot.links?.length ? snapshot.links : config.links || [];
  return `<article class="provider-row" data-provider="${escapeHtml(config.id)}">
    <div class="provider-identity">
      <strong>${escapeHtml(config.name)}</strong>
      <small>${escapeHtml(config.target_url)}</small>
    </div>
    <div class="provider-state">
      <span class="status ${escapeHtml(snapshot.status || "idle")}">${escapeHtml(statusLabel(snapshot.status))}</span>
      <small class="recommendation ${escapeHtml(snapshot.recommendation || "watch")}">${escapeHtml(recommendationLabel(snapshot.recommendation))}</small>
    </div>
    <div class="provider-metrics">
      ${balances.length ? balances.map(formatMetric).join("") : '<span class="muted">暂无余额</span>'}
      ${details.map(formatMetric).join("")}
    </div>
    <div class="row-actions">
      ${links.map((link) => `<a class="button" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}
      <button type="button" data-refresh>刷新</button>
    </div>
    ${snapshot.error ? `<p class="row-error">${escapeHtml(snapshot.error)}</p>` : ""}
  </article>`;
}

function render() {
  const groups = new Map();
  for (const provider of providers) {
    const group = String(provider.group || "").trim();
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(provider);
  }
  const root = document.getElementById("provider-groups");
  root.innerHTML = providers.length ? [...groups].map(([name, configs]) => `
    <section class="provider-group">
      <div class="group-heading"><h2>${escapeHtml(name || "未分组")}</h2><span>${configs.length}</span></div>
      <div class="provider-list">${configs.map(providerRow).join("")}</div>
    </section>`).join("") : '<div class="empty">没有已启用的 Provider</div>';

  const healthy = snapshots.filter((item) => item.status === "ok").length;
  const attention = snapshots.filter((item) => item.status === "error" || item.status === "stale" || item.recommendation === "recharge").length;
  document.getElementById("provider-count").textContent = providers.length;
  document.getElementById("healthy-count").textContent = healthy;
  document.getElementById("attention-count").textContent = attention;
  const updated = snapshots.map((item) => Date.parse(item.updated_at || "")).filter(Number.isFinite);
  document.getElementById("refresh-meta").textContent = updated.length
    ? `最近更新 ${new Date(Math.max(...updated)).toLocaleString()}`
    : "尚未生成采集快照";
  setControlsDisabled(activeOperation);
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", isError);
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = disabled && button.id !== "cancel-refresh";
  });
}

function setCancelVisible(visible) {
  const button = document.getElementById("cancel-refresh");
  button.hidden = !visible;
  button.disabled = !visible;
}

function setRetryVisible(visible) {
  const button = document.getElementById("retry-failed");
  button.hidden = !visible;
  button.disabled = !visible || activeOperation;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function refreshJobMessage(job) {
  const completed = Number(job.completed || 0);
  const total = Number(job.total || 0);
  const active = (job.providers || [])
    .filter((provider) => provider.status === "refreshing")
    .map((provider) => provider.name);
  const elapsed = Math.max(0, Date.now() - Date.parse(job.startedAt || ""));
  const elapsedHint = elapsed >= 60000 ? ` · 已耗时 ${Math.floor(elapsed / 60000)} 分钟` : "";
  const current = active.length ? ` · 正在刷新 ${active.slice(0, 2).join("、")}${active.length > 2 ? " 等" : ""}` : " · 正在准备浏览器";
  return `刷新进度 ${completed}/${total}${current}${elapsedHint}`;
}

function showRefreshProgress(job) {
  const progress = document.getElementById("refresh-progress");
  progress.hidden = false;
  progress.max = Math.max(1, Number(job.total || 0));
  progress.value = Number(job.completed || 0);
  setMessage(refreshJobMessage(job));
}

async function loadStatus() {
  const data = await requestJson("/api/providers", { timeout: 20000 });
  providers = data.configs || [];
  snapshots = data.providers || [];
  lastStatusLoadAt = Date.now();
  render();
}

function reloadStatusIfVisible(force = false) {
  if (activeOperation || document.visibilityState === "hidden" || statusReloadPromise) return;
  if (!force && Date.now() - lastStatusLoadAt < 1000) return;
  statusReloadPromise = loadStatus()
    .catch((error) => setMessage(error.message || "读取状态失败", true))
    .finally(() => { statusReloadPromise = null; });
}

async function runOperation(message, operation) {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setMessage(message);
  try {
    await operation();
    await loadStatus();
    setMessage(`刷新完成 · ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setMessage(error.name === "AbortError" ? "请求超时" : error.message || "操作失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

async function monitorRefresh(job) {
  let lastCompleted = Number(job.completed || 0);
  setCancelVisible(["running", "cancelling"].includes(job?.status));
  while (["running", "cancelling"].includes(job?.status)) {
    showRefreshProgress(job);
    if (job.status === "cancelling") setMessage("正在取消刷新...");
    await delay(800);
    const data = await requestJson("/api/refresh", { timeout: 20000 });
    job = data.refresh;
    if (!job) throw new Error("刷新任务状态已丢失");
    if (Number(job.completed || 0) !== lastCompleted) {
      lastCompleted = Number(job.completed || 0);
      await loadStatus();
    }
  }

  if (!job) throw new Error("刷新任务状态已丢失");
  const progress = document.getElementById("refresh-progress");
  progress.hidden = false;
  progress.max = Math.max(1, Number(job.total || 0));
  progress.value = Number(job.completed || 0);
  await loadStatus();
  const failures = Number(job.failureCount || 0);
  setCancelVisible(false);
  setRetryVisible(failures > 0);
  if (job.status === "cancelled") {
    setMessage(`刷新已取消：完成 ${job.completed}/${job.total}`);
  } else if (job.status === "interrupted") {
    setMessage(`刷新中断：${job.error || "服务重启导致任务中断"}`, true);
  } else if (job.status === "failed") {
    setMessage(`刷新中断：${job.error || "后台任务失败"}（${job.completed}/${job.total}）`, true);
  } else if (failures) {
    setMessage(`刷新完成：成功 ${job.successCount}，失败 ${failures} · ${new Date().toLocaleTimeString()}`, true);
  } else {
    setMessage(`刷新完成：${job.completed}/${job.total} · ${new Date().toLocaleTimeString()}`);
  }
}

async function refreshAll() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setCancelVisible(true);
  setRetryVisible(false);
  setMessage("正在创建刷新任务...");
  try {
    const data = await requestJson("/api/refresh", { method: "POST", timeout: 20000 });
    await monitorRefresh(data.refresh);
  } catch (error) {
    setMessage(error.name === "AbortError" ? "读取刷新进度超时" : error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
  }
}

async function retryFailed() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setRetryVisible(false);
  setMessage("正在创建失败项重试任务...");
  try {
    const data = await requestJson("/api/refresh/retry", { method: "POST", timeout: 20000 });
    if (!data.started) {
      setMessage("当前没有可重试的失败 Provider");
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
  const button = document.getElementById("cancel-refresh");
  button.disabled = true;
  try {
    const data = await requestJson("/api/refresh/cancel", { method: "POST", timeout: 20000 });
    if (data.cancelled) setMessage("正在取消刷新...");
  } catch (error) {
    button.disabled = false;
    setMessage(error.message || "取消刷新失败", true);
  }
}

async function initialize() {
  await loadStatus();
  const data = await requestJson("/api/refresh", { timeout: 20000 });
  const persisted = data.refresh;
  if (!["running", "cancelling"].includes(persisted?.status)) {
    setRetryVisible(Number(persisted?.failureCount || 0) > 0);
    if (persisted?.status === "interrupted" || persisted?.status === "failed") {
      setMessage(`上次刷新中断：${persisted.error || "后台任务失败"}`, true);
    } else if (persisted?.status === "cancelled") {
      setMessage(`上次刷新已取消：完成 ${persisted.completed}/${persisted.total}`);
    } else if (persisted?.status === "completed") {
      setMessage(`最近刷新完成：${persisted.completed}/${persisted.total}`);
    }
    return;
  }
  activeOperation = true;
  setControlsDisabled(true);
  setCancelVisible(true);
  try {
    await monitorRefresh(data.refresh);
  } catch (error) {
    setMessage(error.name === "AbortError" ? "读取刷新进度超时" : error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
  }
}

document.getElementById("refresh-all").addEventListener("click", refreshAll);
document.getElementById("retry-failed").addEventListener("click", retryFailed);
document.getElementById("cancel-refresh").addEventListener("click", cancelRefresh);
document.getElementById("sync-auth").addEventListener("click", () => runOperation(
  "正在同步 BrowserOS 登录态...",
  () => requestJson("/api/sync-auth", { method: "POST", timeout: 120000 })
));
document.getElementById("open-all").addEventListener("click", () => providers.forEach((provider) => {
  window.open(provider.target_url, "_blank", "noopener,noreferrer");
}));
document.getElementById("provider-groups").addEventListener("click", (event) => {
  const button = event.target.closest("[data-refresh]");
  if (!button) return;
  const row = button.closest("[data-provider]");
  const provider = providers.find((item) => item.id === row.dataset.provider);
  if (provider) runOperation(`正在刷新 ${provider.name}...`, () => requestJson(
    `/api/providers/${encodeURIComponent(provider.id)}/refresh`, { method: "POST" }
  ));
});
window.providerConfigEvents?.subscribe(() => reloadStatusIfVisible(true));
window.addEventListener("focus", () => reloadStatusIfVisible());
document.addEventListener("visibilitychange", () => reloadStatusIfVisible());

initialize().catch((error) => setMessage(error.message || "读取状态失败", true));
