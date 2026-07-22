let configs = [];
let snapshots = [];
let activeOperation = false;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
}

function statusLabel(status) {
  return ({ ok: "ok", stale: "stale", error: "error", idle: "idle", unconfigured: "unconfigured" })[status] || status || "idle";
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
  document.querySelectorAll("[data-refresh-provider]").forEach((button) => {
    button.disabled = disabled;
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

function formatQuotaAmount(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "";
}

function quotaSummary(value) {
  const match = String(value || "").match(/([$¥￥])?\s*(\d+(?:\.\d+)?)\s*\/\s*([$¥￥])?\s*(\d+(?:\.\d+)?)/);
  if (!match) return String(value || "");
  const [, leftSymbol, usedRaw, rightSymbol, limitRaw] = match;
  const used = Number(usedRaw);
  const limit = Number(limitRaw);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return String(value || "");
  const symbol = leftSymbol || rightSymbol || "$";
  const remaining = limit - used;
  const remainingLabel = remaining < 0 ? "超出" : "剩余";
  return `${symbol}${formatQuotaAmount(used)} / ${symbol}${formatQuotaAmount(limit)} · ${remainingLabel} ${symbol}${formatQuotaAmount(Math.abs(remaining))}`;
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
        ${links.map((link) => `<a class="button primary" href="${escapeHtml(link.url)}" target="_blank">${escapeHtml(link.label)}</a>`).join("")}
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

async function loadStatus() {
  const data = await sendMessage({ type: "providers:list" });
  configs = data.configs;
  snapshots = data.providers;
  render();
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
  try {
    for (let index = 0; index < configs.length; index += 1) {
      setMessage(`正在刷新 ${configs[index].name} (${index + 1}/${configs.length})`);
      await refreshProviderInternal(configs[index].id);
    }
    setMessage(`刷新完成：${new Date().toLocaleTimeString()}`);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

document.getElementById("refresh-all").addEventListener("click", refreshAll);
document.getElementById("open-all").addEventListener("click", () => {
  configs.forEach((config) => chrome.tabs.create({ url: config.targetUrl, active: false }));
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

loadStatus().catch((error) => setMessage(error.message, true));
