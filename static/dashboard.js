let providers = [];
let snapshots = [];
let activeOperation = false;

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
  document.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
}

async function loadStatus() {
  const data = await requestJson("/api/providers", { timeout: 20000 });
  providers = data.configs || [];
  snapshots = data.providers || [];
  render();
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

document.getElementById("refresh-all").addEventListener("click", () => runOperation(
  "正在刷新全部 Provider...",
  () => requestJson("/api/refresh", { method: "POST" })
));
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

loadStatus().catch((error) => setMessage(error.message || "读取状态失败", true));
