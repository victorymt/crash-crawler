let configs = [];
let snapshots = [];
let activeOperation = false;
let providersLoaded = false;
let currentPage = null;

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

function render() {
  const root = document.getElementById("provider-list");
  root.innerHTML = configs.map((config) => {
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
  }).join("");
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
  providersLoaded = true;
  render();
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
  setMessage("正在并行刷新所有 provider...");
  try {
    const data = await sendMessage({ type: "providers:refreshAll" });
    snapshots = data.providers || [];
    render();
    setMessage(`刷新完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setMessage(error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

document.getElementById("refresh-all").addEventListener("click", refreshAll);
document.getElementById("add-current-page").addEventListener("click", addCurrentPage);
document.getElementById("open-all").addEventListener("click", () => {
  configs.forEach((config) => chrome.tabs.create({ url: config.targetUrl, active: false }));
});
document.getElementById("channels").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/channels/channels.html") });
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

Promise.all([loadStatus(), loadCurrentPage()]).catch((error) => setMessage(error.message, true));
