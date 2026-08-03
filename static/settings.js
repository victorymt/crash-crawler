let configs = [];
let settings = {};
let hasDeepseekKey = false;
let editingId = "";
let activeOperation = false;
const selectedIds = new Set();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.classList.toggle("error", isError);
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, input, select, textarea").forEach((node) => { node.disabled = disabled; });
}

function providerRow(config, index) {
  return `<div class="provider-config-row${config.enabled ? "" : " disabled"}" data-provider="${escapeHtml(config.id)}">
    <label class="provider-select" title="选择 ${escapeHtml(config.name)}"><input type="checkbox" data-select ${selectedIds.has(config.id) ? "checked" : ""}></label>
    <span class="config-identity"><strong>${escapeHtml(config.name)}</strong><small>${escapeHtml(config.group || "未分组")} · ${escapeHtml(config.target_url)}</small></span>
    <span class="type-tag">${escapeHtml(config.type)}</span>
    <span class="ratio-cell">充值 1:${escapeHtml(config.recharge_ratio)}</span>
    <span class="enabled-cell">${config.enabled ? "已启用" : "已停用"}</span>
    <span class="config-actions">
      <span class="order-actions">
        <button type="button" class="compact" data-move="up" title="上移" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" class="compact" data-move="down" title="下移" ${index === configs.length - 1 ? "disabled" : ""}>下移</button>
      </span>
      <button type="button" class="compact" data-edit>编辑</button>
    </span>
  </div>`;
}

function render() {
  document.getElementById("provider-list").innerHTML = configs.length
    ? configs.map(providerRow).join("")
    : '<div class="empty">没有 Provider 配置</div>';
  const groups = [...new Set(configs.map((config) => config.group).filter(Boolean))];
  document.getElementById("group-options").innerHTML = groups.map((group) => `<option value="${escapeHtml(group)}"></option>`).join("");
  document.getElementById("selection-meta").textContent = selectedIds.size ? `已选择 ${selectedIds.size} 个 Provider` : "未选择 Provider";
  const selectAll = document.getElementById("select-all");
  selectAll.checked = configs.length > 0 && selectedIds.size === configs.length;
  selectAll.indeterminate = selectedIds.size > 0 && selectedIds.size < configs.length;
  document.getElementById("auto-refresh").value = String(settings.auto_refresh_minutes || 0);
  setControlsDisabled(activeOperation);
}

async function loadConfig() {
  const data = await requestJson("/api/config");
  configs = data.configs || [];
  settings = data.settings || {};
  hasDeepseekKey = Boolean(data.has_deepseek_key);
  for (const id of [...selectedIds]) if (!configs.some((config) => config.id === id)) selectedIds.delete(id);
  render();
}

async function runMutation(message, operation) {
  if (activeOperation) return;
  activeOperation = true;
  setControlsDisabled(true);
  setMessage(message);
  try {
    await operation();
    await loadConfig();
    setMessage("已保存");
  } catch (error) {
    setMessage(error.message || "操作失败", true);
    throw error;
  } finally {
    activeOperation = false;
    setControlsDisabled(false);
  }
}

async function replaceConfigs(nextConfigs) {
  await requestJson("/api/config/providers", {
    method: "POST",
    body: JSON.stringify({ providers: nextConfigs })
  });
}

function parseJsonField(id, fallback) {
  const value = document.getElementById(id).value.trim();
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${id === "parser-rules" ? "解析规则" : "附加页面"} JSON 格式错误: ${error.message}`);
  }
}

function updateEditorPanels() {
  const type = document.getElementById("provider-type").value;
  document.getElementById("page-panel").hidden = type !== "page";
  document.getElementById("newapi-panel").hidden = type !== "newapi";
  document.getElementById("deepseek-panel").hidden = type !== "deepseek";
}

function openEditor(config = null) {
  editingId = config?.id || "";
  document.getElementById("editor-title").textContent = config ? `编辑 ${config.name}` : "新增 Provider";
  document.getElementById("provider-id").value = config?.id || "";
  document.getElementById("provider-id").readOnly = Boolean(config);
  document.getElementById("provider-name").value = config?.name || "";
  document.getElementById("provider-type").value = config?.type || "page";
  document.getElementById("provider-group").value = config?.group || "";
  document.getElementById("provider-url").value = config?.target_url || "";
  document.getElementById("provider-ratio").value = String(config?.recharge_ratio || 1);
  document.getElementById("provider-enabled").checked = config?.enabled !== false;
  document.getElementById("quota-per-unit").value = String(config?.quota_per_unit || 500000);
  document.getElementById("secondary-urls").value = config?.secondary_urls?.length ? JSON.stringify(config.secondary_urls, null, 2) : "";
  document.getElementById("parser-rules").value = config?.parser_rules ? JSON.stringify(config.parser_rules, null, 2) : "";
  document.getElementById("deepseek-key").value = "";
  document.getElementById("deepseek-key-status").textContent = hasDeepseekKey ? "已保存本地密钥" : "尚未保存本地密钥";
  document.getElementById("clear-deepseek-key").hidden = !hasDeepseekKey;
  document.getElementById("delete-zone").hidden = !config;
  updateEditorPanels();
  document.getElementById("provider-dialog").showModal();
}

function closeEditor() {
  document.getElementById("provider-dialog").close();
  editingId = "";
}

function editorProvider() {
  const type = document.getElementById("provider-type").value;
  const previous = configs.find((config) => config.id === editingId) || {};
  const provider = {
    ...previous,
    id: document.getElementById("provider-id").value.trim(),
    name: document.getElementById("provider-name").value.trim(),
    type,
    target_url: document.getElementById("provider-url").value.trim(),
    group: document.getElementById("provider-group").value.trim(),
    recharge_ratio: Number(document.getElementById("provider-ratio").value),
    enabled: document.getElementById("provider-enabled").checked,
    mode: type === "deepseek" ? "api" : "browser"
  };
  if (type === "newapi") provider.quota_per_unit = Number(document.getElementById("quota-per-unit").value);
  else delete provider.quota_per_unit;
  if (type === "page") {
    provider.secondary_urls = parseJsonField("secondary-urls", []);
    provider.parser_rules = parseJsonField("parser-rules", {});
  } else {
    delete provider.parser_rules;
  }
  return provider;
}

document.getElementById("provider-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-provider]");
  if (!row) return;
  const id = row.dataset.provider;
  if (event.target.closest("[data-edit]")) {
    openEditor(configs.find((config) => config.id === id));
    return;
  }
  const move = event.target.closest("[data-move]")?.dataset.move;
  if (!move) return;
  const index = configs.findIndex((config) => config.id === id);
  const target = move === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= configs.length) return;
  const next = [...configs];
  [next[index], next[target]] = [next[target], next[index]];
  runMutation("正在保存排序...", () => replaceConfigs(next)).catch(() => {});
});

document.getElementById("provider-list").addEventListener("change", (event) => {
  if (!event.target.matches("[data-select]")) return;
  const id = event.target.closest("[data-provider]").dataset.provider;
  if (event.target.checked) selectedIds.add(id); else selectedIds.delete(id);
  render();
});

document.getElementById("select-all").addEventListener("change", (event) => {
  selectedIds.clear();
  if (event.target.checked) configs.forEach((config) => selectedIds.add(config.id));
  render();
});

document.getElementById("move-selected").addEventListener("click", () => {
  if (!selectedIds.size) return setMessage("请先选择 Provider", true);
  const group = document.getElementById("bulk-group").value.trim();
  const next = configs.map((config) => selectedIds.has(config.id) ? { ...config, group } : config);
  runMutation("正在移动 Provider...", async () => {
    await replaceConfigs(next);
    selectedIds.clear();
  }).catch(() => {});
});

document.getElementById("provider-form").addEventListener("submit", (event) => {
  event.preventDefault();
  let provider;
  try { provider = editorProvider(); } catch (error) { return setMessage(error.message, true); }
  const key = document.getElementById("deepseek-key").value.trim();
  runMutation("正在保存 Provider...", async () => {
    await requestJson("/api/config/provider", { method: "POST", body: JSON.stringify({ provider }) });
    if (provider.type === "deepseek" && key) {
      await requestJson("/api/secrets/deepseek", { method: "POST", body: JSON.stringify({ value: key }) });
    }
    closeEditor();
  }).catch(() => {});
});

document.getElementById("delete-provider").addEventListener("click", () => {
  const config = configs.find((item) => item.id === editingId);
  if (!config || !window.confirm(`确定删除 ${config.name}？`)) return;
  runMutation("正在删除 Provider...", async () => {
    await requestJson(`/api/config/providers/${encodeURIComponent(config.id)}`, { method: "DELETE" });
    closeEditor();
  }).catch(() => {});
});

document.getElementById("clear-deepseek-key").addEventListener("click", () => {
  if (!window.confirm("确定清除本地 DeepSeek API Key？")) return;
  runMutation("正在清除 DeepSeek 密钥...", async () => {
    await requestJson("/api/secrets/deepseek", { method: "DELETE" });
    hasDeepseekKey = false;
    document.getElementById("deepseek-key-status").textContent = "尚未保存本地密钥";
    document.getElementById("clear-deepseek-key").hidden = true;
  }).catch(() => {});
});

document.getElementById("save-settings").addEventListener("click", () => {
  const next = { auto_refresh_minutes: Number(document.getElementById("auto-refresh").value) };
  runMutation("正在保存自动刷新设置...", () => requestJson("/api/config/settings", {
    method: "POST", body: JSON.stringify({ settings: next })
  })).catch(() => {});
});

document.getElementById("export-config").addEventListener("click", () => {
  const portableConfigs = configs.map((config) => ({
    schemaVersion: 4,
    id: config.id,
    name: config.name,
    group: config.group || "",
    type: config.type,
    targetUrl: config.target_url,
    rechargeRatio: config.recharge_ratio,
    enabled: config.enabled !== false,
    mode: config.mode,
    secondaryUrls: config.secondary_urls || [],
    ...(config.parser_rules ? { parserRules: config.parser_rules } : {}),
    ...(config.type === "newapi" ? { quotaPerUnit: config.quota_per_unit || 500000 } : {})
  }));
  const blob = new Blob([JSON.stringify(portableConfigs, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "provider-usage-hub.json";
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-config").addEventListener("click", () => document.getElementById("import-file").click());
document.getElementById("import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    const documentData = JSON.parse(await file.text());
    const providers = Array.isArray(documentData)
      ? documentData
      : Array.isArray(documentData.providers)
        ? documentData.providers
        : documentData.id
          ? [documentData]
          : null;
    if (!Array.isArray(providers)) throw new Error("导入文件缺少 providers 数组");
    await runMutation("正在导入 Provider...", () => replaceConfigs(providers));
  } catch (error) {
    setMessage(error.message || "导入失败", true);
  }
});

document.getElementById("add-provider").addEventListener("click", () => openEditor());
document.getElementById("provider-type").addEventListener("change", updateEditorPanels);
document.getElementById("close-editor").addEventListener("click", closeEditor);
document.getElementById("cancel-editor").addEventListener("click", closeEditor);
document.getElementById("provider-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeEditor();
});

loadConfig().catch((error) => setMessage(error.message || "读取配置失败", true));
