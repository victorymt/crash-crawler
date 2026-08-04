import { groupProviderConfigs } from "../shared/provider_groups.js";
import { snapshotNeedsRetry } from "../shared/snapshots.js";

let configs = [];
let snapshots = [];
let activeOperation = false;
let providersLoaded = false;
let currentPage = null;
const collapsedGroups = new Set();
let extensionSettings = {};
let groupCollapseInitialized = false;
let groupCollapseDefault = null;
let knownGroupNames = new Set();

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
}

function statusLabel(status) {
  return ({ ok: "ok", stale: "stale", error: "error", idle: "idle", unconfigured: "unconfigured", needs_visit: "needs visit" })[status] || status || "idle";
}

function recommendationLabel(value) {
  return ({ ok: "余额正常", watch: "需要关注", recharge: "建议充值" })[value] || "需要关注";
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(isError));
}

function setControlsDisabled(disabled) {
  document.getElementById("refresh-all").disabled = disabled;
  document.getElementById("retry-failed").disabled = disabled;
  const cancelButton = document.getElementById("cancel-refresh");
  cancelButton.disabled = !activeOperation;
  const addButton = document.getElementById("add-current-page");
  const existing = providerForCurrentPage();
  addButton.textContent = existing?.type === "page"
    ? "识别 Provider"
    : existing
      ? "已在 Provider"
      : "添加到 Provider";
  addButton.disabled = disabled || !providersLoaded || !currentPage || Boolean(existing && existing.type !== "page");
  document.querySelectorAll("[data-refresh-provider]").forEach((button) => {
    button.disabled = disabled;
  });
}

function setCancelVisible(visible) {
  const button = document.getElementById("cancel-refresh");
  button.hidden = !visible;
  button.disabled = !visible;
}

function hasFailedSnapshots() {
  return snapshots.some((snapshot) => snapshotNeedsRetry(snapshot));
}

function setRetryVisible(visible) {
  const button = document.getElementById("retry-failed");
  button.hidden = !visible;
  button.disabled = !visible || activeOperation;
}

function showRefreshProgress(run) {
  const progress = document.getElementById("refresh-progress");
  progress.hidden = false;
  progress.max = Math.max(1, Object.keys(run?.providers || {}).length);
  progress.value = Object.values(run?.providers || {}).filter((state) => state.state === "complete").length;
  const active = Object.values(run?.providers || {})
    .filter((state) => state.state === "running")
    .map((state) => state.currentStep)
    .filter(Boolean);
  setMessage(`后台刷新进度 ${progress.value}/${progress.max}${active.length ? ` · ${active[0]}` : ""}`);
}

async function monitorRefreshStatus(run) {
  let lastUpdated = run.updatedAt || run.startedAt || "";
  setCancelVisible(true);
  while (run?.state === "running") {
    showRefreshProgress(run);
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    const data = await sendMessage({ type: "providers:refreshStatus" });
    run = data.refresh;
    if (!run) break;
    if (run.updatedAt !== lastUpdated) {
      lastUpdated = run.updatedAt || "";
      await loadStatus();
    }
  }
  if (!run) return;
  await loadStatus();
  const failed = Object.values(run.providers || {})
    .filter((state) => state.snapshotStatus && state.snapshotStatus !== "ok")
    .length;
  if (run.state === "cancelled") {
    setMessage("后台刷新已取消");
  } else if (run.state === "interrupted") {
    setMessage("后台刷新已中断", true);
  } else if (failed) {
    setMessage(`后台刷新完成：${failed} 个 Provider 需要重试`, true);
  } else if (run.state === "complete") {
    setMessage("后台刷新完成");
  }
  setRetryVisible(hasFailedSnapshots());
}

async function restoreRefreshStatus() {
  const data = await sendMessage({ type: "providers:refreshStatus" });
  const run = data.refresh;
  if (!run || run.state !== "running") {
    if (run?.state === "interrupted") setMessage("上次后台刷新已中断", true);
    setRetryVisible(hasFailedSnapshots());
    return;
  }
  activeOperation = true;
  setControlsDisabled(true);
  try {
    await monitorRefreshStatus(run);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
    setRetryVisible(hasFailedSnapshots());
  }
}

function pageOrigin(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function providerForCurrentPage() {
  const origin = pageOrigin(currentPage?.url);
  return origin ? configs.find((config) => pageOrigin(config.targetUrl) === origin) : null;
}

async function loadCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = pageOrigin(tab?.url);
  currentPage = origin ? { url: tab.url, title: tab.title || new URL(tab.url).hostname } : null;
  const button = document.getElementById("add-current-page");
  button.title = currentPage ? `添加 ${new URL(currentPage.url).hostname}` : "当前页面不可添加";
  setControlsDisabled(activeOperation);
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

function formatQuotaAmount(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "";
}

export function quotaSummary(value) {
  const match = String(value || "").match(/^\s*([$¥￥])?\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{3,8})?\s*\/\s*([$¥￥])?\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{3,8})?\s*$/);
  if (!match) return String(value || "");
  const [, leftSymbol, usedRaw, leftCurrency, rightSymbol, limitRaw, rightCurrency] = match;
  const used = Number(usedRaw);
  const limit = Number(limitRaw);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return String(value || "");
  const symbol = leftSymbol || rightSymbol || "";
  const currency = leftCurrency || rightCurrency || "";
  const format = (amount) => symbol
    ? `${symbol}${formatQuotaAmount(amount)}`
    : `${formatQuotaAmount(amount)}${currency ? ` ${currency}` : ""}`;
  const remaining = limit - used;
  const remainingLabel = remaining < 0 ? "超出" : "剩余";
  return `${format(used)} / ${format(limit)} · ${remainingLabel} ${format(Math.abs(remaining))}`;
}

function metricHtml(metric) {
  const percent = Number.isFinite(metric.percent) ? Math.max(0, Math.min(100, metric.percent)) : null;
  const bar = percent == null ? "" : `<div class="bar"><i data-percent="${percent}"></i></div>`;
  const valueText = metric.value ? quotaSummary(metric.value) : "";
  const resetText = metric.resetIn || metric.reset_in || "";
  const right = valueText || (resetText ? `重置: ${resetText}` : "");
  const detail = valueText && resetText ? `<div class="metric-sub">重置: ${escapeHtml(resetText)}</div>` : "";
  return `<div class="metric">
    <div class="metric-top"><span>${escapeHtml(metric.label)}</span><span>${escapeHtml(right)}</span></div>
    ${bar}
    ${detail}
  </div>`;
}

function balanceHtml(balance) {
  const currency = balance.currency ? ` ${balance.currency}` : "";
  return `<div class="amount">
    <div class="amount-label" title="${escapeHtml(balance.label)}">${escapeHtml(balance.label)}</div>
    <div class="amount-value">${escapeHtml(balance.value)}${escapeHtml(currency)}</div>
  </div>`;
}

function providerCardHtml(config) {
  const snapshot = snapshots.find((item) => item.id === config.id) || {};
  const balances = snapshot.balances || [];
  const balanceKeys = new Set(balances.map((item) => `${item.key}|${item.label}|${item.value}`));
  const usage = snapshot.usage?.length
    ? snapshot.usage
    : (snapshot.metrics || []).filter((item) => !balanceKeys.has(`${item.key}|${item.label}|${item.value}`));
  const links = snapshot.links || config.links || [{ label: "打开官方页面", url: config.targetUrl }];
  return `<article class="provider-card">
      <div class="card-head">
        <div>
          <div class="provider-name">${escapeHtml(config.name)}</div>
          <div class="provider-meta">${escapeHtml(snapshot.updatedAt || "未解析")}</div>
        </div>
        <span class="status ${escapeHtml(snapshot.status || "")}">${escapeHtml(statusLabel(snapshot.status))}</span>
      </div>
      <div class="recommendation ${escapeHtml(snapshot.recommendation || "watch")}">${escapeHtml(recommendationLabel(snapshot.recommendation))}</div>
      <div class="section-title">余额</div>
      ${balances.length ? `<div class="amount-grid">${balances.map(balanceHtml).join("")}</div>` : '<div class="empty">暂无余额数据。</div>'}
      <div class="section-title">用量 / 订阅</div>
      ${usage.length ? `<div class="metrics">${usage.map(metricHtml).join("")}</div>` : '<div class="empty">暂无用量或订阅数据。</div>'}
      ${snapshot.error ? `<div class="error">${escapeHtml(snapshot.error)}</div>` : ""}
      <div class="actions">
        ${links.map((link) => `<a class="button primary" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}
        <button data-refresh-provider="${escapeHtml(config.id)}">刷新</button>
        <button data-copy="${escapeHtml(config.id)}">复制 URL</button>
      </div>
    </article>`;
}

function syncGroupCollapseState(groups) {
  const shouldCollapse = extensionSettings.collapseProviderGroupsByDefault !== false;
  const currentNames = new Set(groups.map((group) => group.name));
  for (const groupName of collapsedGroups) {
    if (!currentNames.has(groupName)) collapsedGroups.delete(groupName);
  }

  if (!groupCollapseInitialized || groupCollapseDefault !== shouldCollapse) {
    collapsedGroups.clear();
    if (shouldCollapse) groups.slice(1).forEach((group) => collapsedGroups.add(group.name));
    groupCollapseInitialized = true;
    groupCollapseDefault = shouldCollapse;
  } else if (shouldCollapse) {
    groups.forEach((group, index) => {
      if (!knownGroupNames.has(group.name) && index > 0) collapsedGroups.add(group.name);
    });
  }
  knownGroupNames = currentNames;
}

function render() {
  const root = document.getElementById("provider-list");
  const groups = groupProviderConfigs(configs);
  syncGroupCollapseState(groups);
  root.innerHTML = groups.map((group) => {
    const collapsed = collapsedGroups.has(group.name);
    return `<section class="provider-group ${collapsed ? "collapsed" : ""}" data-provider-group="${escapeHtml(group.name)}">
      <button class="provider-group-toggle" type="button" data-toggle-provider-group="${escapeHtml(group.name)}" aria-expanded="${!collapsed}">
        <span class="group-chevron" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
        <span class="provider-group-name">${escapeHtml(group.label)}</span>
        <span class="provider-group-count">${group.providers.length}</span>
      </button>
      <div class="provider-grid">${group.providers.map(providerCardHtml).join("")}</div>
    </section>`;
  }).join("");
  root.querySelectorAll("[data-toggle-provider-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupName = button.dataset.toggleProviderGroup;
      if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
      else collapsedGroups.add(groupName);
      render();
    });
  });
  root.querySelectorAll("[data-refresh-provider]").forEach((button) => {
    button.addEventListener("click", () => refreshProvider(button.dataset.refreshProvider));
  });
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const config = configs.find((item) => item.id === button.dataset.copy);
      await navigator.clipboard.writeText(config.targetUrl);
      setMessage(`${config.name} URL 已复制`);
    });
  });
  root.querySelectorAll("[data-percent]").forEach((node) => {
    node.style.width = `${node.dataset.percent}%`;
  });
  setControlsDisabled(activeOperation);
}

function autoRefreshHint(settings) {
  const minutes = Number(settings?.autoRefreshMinutes || 0);
  if (!minutes) return "";
  if (settings?.lastAutoRefreshError) {
    return `后台刷新失败：${settings.lastAutoRefreshError}`;
  }
  const policy = settings?.autoRefreshTabPolicy === "allow-hidden-tabs"
    ? "可创建后台页"
    : settings?.autoRefreshTabPolicy === "api-only"
      ? "仅 API / HTTP"
      : "仅复用已打开页";
  if (settings?.lastAutoRefreshAt) {
    return `后台每 ${minutes} 分钟刷新 · ${policy} · 上次 ${new Date(settings.lastAutoRefreshAt).toLocaleTimeString()}`;
  }
  return `后台每 ${minutes} 分钟自动刷新 · ${policy}`;
}

async function loadStatus() {
  const data = await sendMessage({ type: "providers:list" });
  configs = data.configs;
  snapshots = data.providers;
  extensionSettings = data.settings || {};
  providersLoaded = true;
  render();
  setRetryVisible(hasFailedSnapshots());
  const hint = autoRefreshHint(data.settings);
  if (hint) setMessage(hint);
}

function detectedTypeLabel(type) {
  return ({ newapi: "NewAPI", sub2api: "Sub2API" })[type] || type || "Provider";
}

async function addCurrentPage() {
  const existing = providerForCurrentPage();
  if (activeOperation || !currentPage || (existing && existing.type !== "page")) return;
  activeOperation = true;
  setControlsDisabled(true);
  const hostname = new URL(currentPage.url).hostname;
  setMessage(`正在识别 ${hostname}...`);
  try {
    const origin = `${new URL(currentPage.url).origin}/*`;
    if (!await chrome.permissions.request({ origins: [origin] })) {
      throw new Error(`未获得站点访问权限：${origin}`);
    }
    const data = await sendMessage({ type: "providers:addCurrentPage", page: currentPage });
    await loadStatus();
    setMessage(data.upgraded
      ? `${data.provider.name} 已识别为 ${detectedTypeLabel(data.detectedType)}`
      : data.added
        ? `${data.provider.name} 已添加为 ${detectedTypeLabel(data.detectedType)}`
        : `${data.provider.name} 已在 Provider 中`);
  } catch (error) {
    setMessage(error.message || "当前页面添加失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.providerSnapshots || activeOperation || !configs.length) return;
    const next = changes.providerSnapshots.newValue || {};
    let changed = false;
    const merged = configs.map((config) => {
      const snapshot = next[config.id];
      if (!snapshot) return snapshots.find((item) => item.id === config.id);
      const previous = snapshots.find((item) => item.id === config.id);
      if (
        !previous
        || previous.checkedAt !== snapshot.checkedAt
        || previous.updatedAt !== snapshot.updatedAt
        || previous.status !== snapshot.status
        || previous.error !== snapshot.error
      ) {
        changed = true;
      }
      return snapshot;
    }).filter(Boolean);
    if (!changed) return;
  snapshots = merged;
  render();
  setRetryVisible(hasFailedSnapshots());
    setMessage(`快照已更新：${new Date().toLocaleTimeString()}`);
  });
}

async function refreshProvider(providerId) {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  try {
    await refreshProviderInternal(providerId);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

async function refreshProviderInternal(providerId) {
  const config = configs.find((item) => item.id === providerId);
  setControlsDisabled(true);
  setMessage(`正在刷新 ${config.name}`);
  try {
    const data = await sendMessage({ type: "providers:refresh", providerId });
    snapshots = snapshots.filter((item) => item.id !== providerId);
    snapshots.push(data.provider);
    render();
    setMessage(`${config.name} 刷新完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || `${config.name} 刷新失败`, true);
  }
}

async function refreshAll() {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setRetryVisible(false);
  setCancelVisible(true);
  setMessage("正在并行刷新所有 provider...");
  try {
    const data = await sendMessage({ type: "providers:refreshAll" });
    const updatedSnapshots = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    for (const snapshot of data.providers || []) updatedSnapshots.set(snapshot.id, snapshot);
    snapshots = configs
      .map((config) => updatedSnapshots.get(config.id))
      .filter(Boolean);
    render();
    setMessage(data.cancelled
      ? `刷新已取消：${new Date().toLocaleTimeString()}`
      : `刷新完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || "刷新失败", true);
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
  setCancelVisible(true);
  setMessage("正在重试失败 provider...");
  try {
    const data = await sendMessage({ type: "providers:refreshFailed" });
    if (!data.started) {
      setMessage("当前没有可重试的失败 provider");
      return;
    }
    const updatedSnapshots = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    for (const snapshot of data.providers || []) updatedSnapshots.set(snapshot.id, snapshot);
    snapshots = configs.map((config) => updatedSnapshots.get(config.id)).filter(Boolean);
    render();
    setRetryVisible(hasFailedSnapshots());
    setMessage(data.cancelled ? "失败 provider 重试已取消" : `失败 provider 重试完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || "重试失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    setCancelVisible(false);
    setRetryVisible(hasFailedSnapshots());
  }
}

async function cancelRefresh() {
  if (!activeOperation) return;
  const button = document.getElementById("cancel-refresh");
  button.disabled = true;
  try {
    const result = await sendMessage({ type: "providers:cancelRefresh" });
    setMessage(result.cancelled ? "正在取消刷新..." : "当前没有运行中的刷新任务");
  } catch (error) {
    button.disabled = false;
    setMessage(error.message || "取消刷新失败", true);
  }
}

document.getElementById("refresh-all").addEventListener("click", refreshAll);
document.getElementById("retry-failed").addEventListener("click", retryFailed);
document.getElementById("cancel-refresh").addEventListener("click", cancelRefresh);
document.getElementById("add-current-page").addEventListener("click", addCurrentPage);
document.getElementById("open-all").addEventListener("click", () => {
  configs.forEach((config) => chrome.tabs.create({ url: config.targetUrl, active: false }));
});
document.getElementById("channels").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/channels/channels.html") });
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

Promise.all([loadStatus(), loadCurrentPage()])
  .then(() => restoreRefreshStatus())
  .catch((error) => setMessage(error.message, true));
