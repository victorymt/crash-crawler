let providers = [];
let activeOperation = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusLabel(status) {
  return ({ ok: "ok", stale: "stale", error: "error", idle: "idle", unconfigured: "unconfigured" })[status] || status || "idle";
}

function recommendationLabel(value) {
  return ({ ok: "余额正常", watch: "需要关注", recharge: "建议充值" })[value] || "需要关注";
}

function openProvider(provider) {
  window.open(provider.target_url, `_blank_provider_${provider.id}`, "noopener");
}

function linkButtons(provider, snapshot) {
  const links = snapshot.links || provider.links || [{ label: "打开官方页面", url: provider.target_url }];
  return links.map((link) => `
    <a class="button primary" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>
  `).join("");
}

function balanceHtml(balance) {
  const currency = balance.currency ? ` ${escapeHtml(balance.currency)}` : "";
  return `<div class="amount">
    <div class="amount-label" title="${escapeHtml(balance.label)}">${escapeHtml(balance.label)}</div>
    <div class="amount-value">${escapeHtml(balance.value)}${currency}</div>
  </div>`;
}

function metricHtml(metric) {
  const value = metric.value || "";
  const percent = Number.isFinite(metric.percent) ? Math.max(0, Math.min(100, metric.percent)) : null;
  const bar = percent === null ? "" : `<div class="bar"><i style="--value: ${percent}%"></i></div>`;
  const right = metric.reset_in ? `重置: ${metric.reset_in}` : value;
  return `<div class="metric">
    <div class="metric-top"><span>${escapeHtml(metric.label)}</span><span>${escapeHtml(right || "")}</span></div>
    ${bar}
  </div>`;
}

function renderLaunchers(snapshots = []) {
  const root = document.getElementById("launchers");
  root.innerHTML = providers.map((provider) => {
    const snapshot = snapshots.find((item) => item.id === provider.id) || {};
    const balances = snapshot.balances || [];
    const balanceKeys = new Set(balances.map((item) => `${item.key}|${item.label}|${item.value}`));
    const usage = (snapshot.usage && snapshot.usage.length ? snapshot.usage : (snapshot.metrics || []).filter((item) => {
      return !balanceKeys.has(`${item.key}|${item.label}|${item.value}`);
    }));
    const balanceBlock = balances.length
      ? `<div class="section-title">余额</div><div class="amount-grid">${balances.map(balanceHtml).join("")}</div>`
      : '<div class="provider-meta">暂无余额数据。</div>';
    const usageBlock = usage.length
      ? `<div class="section-title">用量 / 订阅</div><div class="metrics">${usage.map(metricHtml).join("")}</div>`
      : '<div class="provider-meta">暂无用量或订阅数据。</div>';
    return `
    <article class="launch-panel">
      <div class="launch-head">
        <div class="launch-title" title="${escapeHtml(provider.target_url)}">${escapeHtml(provider.name)}</div>
        <span class="status ${escapeHtml(snapshot.status || "")}">${escapeHtml(statusLabel(snapshot.status))}</span>
      </div>
      <div class="recommendation ${escapeHtml(snapshot.recommendation || "watch")}">${escapeHtml(recommendationLabel(snapshot.recommendation))}</div>
      ${balanceBlock}
      ${usageBlock}
      ${snapshot.error ? `<div class="error">${escapeHtml(snapshot.error)}</div>` : ""}
      <div class="launch-actions">
        ${linkButtons(provider, snapshot)}
        <button data-refresh-provider="${escapeHtml(provider.id)}">刷新</button>
        <button data-copy="${escapeHtml(provider.id)}">复制 URL</button>
      </div>
    </article>
    `;
  }).join("");
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = providers.find((item) => item.id === button.dataset.copy);
      if (provider) {
        navigator.clipboard.writeText(provider.target_url);
      }
    });
  });
  root.querySelectorAll("[data-refresh-provider]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = providers.find((item) => item.id === button.dataset.refreshProvider);
      if (provider) {
        refreshProvider(provider);
      }
    });
  });
  setControlsDisabled(activeOperation);
}

async function loadStatus() {
  const list = document.getElementById("provider-list");
  const response = await fetch("/api/providers");
  const data = await response.json();
  if (Array.isArray(data.configs) && data.configs.length) {
    providers = data.configs;
  }
  renderLaunchers(data.providers || []);
  list.innerHTML = (data.providers || []).map((provider) => `
    <div class="provider-row">
      <div>
        <div class="provider-name">${escapeHtml(provider.name)}</div>
        <div class="provider-meta">${escapeHtml(provider.updated_at || "未解析")}</div>
      </div>
      <span class="status ${escapeHtml(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>
      <div class="metrics">
        ${(provider.metrics || []).map(metricHtml).join("") || '<div class="provider-meta">暂无采集数据。</div>'}
      </div>
      ${provider.error ? `<div class="error">${escapeHtml(provider.error)}</div>` : ""}
    </div>
  `).join("");
}

function setRefreshMessage(message, isError = false) {
  const node = document.getElementById("refresh-message");
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(isError));
}

function setControlsDisabled(disabled) {
  document.getElementById("refresh-all").disabled = disabled;
  document.getElementById("sync-auth").disabled = disabled;
  document.querySelectorAll("[data-refresh-provider]").forEach((button) => {
    button.disabled = disabled;
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时，请稍后重试或检查 provider 登录态");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refreshAll() {
  if (activeOperation) {
    return;
  }
  const button = document.getElementById("refresh-all");
  const originalText = button.textContent;
  activeOperation = true;
  setControlsDisabled(true);
  try {
    button.textContent = "刷新中";
    setRefreshMessage("正在并行刷新所有 provider...");
    await fetchWithTimeout("/api/refresh", { method: "POST" }, 180000);
    await loadStatus();
    setRefreshMessage(`刷新完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setRefreshMessage(error.message || "刷新失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    button.textContent = originalText;
  }
}

async function refreshProvider(provider) {
  if (activeOperation) {
    return;
  }
  activeOperation = true;
  setControlsDisabled(true);
  setRefreshMessage(`正在刷新 ${provider.name}`);
  try {
    await fetchWithTimeout(`/api/providers/${encodeURIComponent(provider.id)}/refresh`, { method: "POST" });
    await loadStatus();
    setRefreshMessage(`${provider.name} 刷新完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    await loadStatus();
    setRefreshMessage(error.message || `${provider.name} 刷新失败`, true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

async function syncAuth() {
  if (activeOperation) {
    return;
  }
  const button = document.getElementById("sync-auth");
  const originalText = button.textContent;
  activeOperation = true;
  setControlsDisabled(true);
  button.textContent = "同步中";
  setRefreshMessage("正在同步 BrowserOS 登录态...");
  try {
    const response = await fetchWithTimeout("/api/sync-auth", { method: "POST" }, 120000);
    const data = await response.json();
    await loadStatus();
    if (data.skipped) {
      setRefreshMessage(`登录态未变化，已跳过复制：${new Date().toLocaleTimeString()}`);
    } else {
      setRefreshMessage(`登录态已同步：${new Date().toLocaleTimeString()}`);
    }
  } catch (error) {
    setRefreshMessage(error.message || "同步登录态失败", true);
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
    button.textContent = originalText;
  }
}

document.getElementById("refresh-all").addEventListener("click", refreshAll);
document.getElementById("sync-auth").addEventListener("click", syncAuth);
document.getElementById("open-all").addEventListener("click", () => providers.forEach(openProvider));
renderLaunchers();
loadStatus();
