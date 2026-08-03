import {
  PROVIDER_SCHEMA_VERSION,
  isBuiltinProviderId,
  normalizeProviderConfig,
  originsForConfig
} from "../shared/config.js";
import {
  UNGROUPED_PROVIDER_LABEL,
  deleteProviderGroup,
  groupProviderConfigs,
  moveProvider,
  moveProvidersToGroup,
  moveProviderGroup,
  renameProviderGroup
} from "../shared/provider_groups.js";

let configs = [];
let draftConfig = null;
let draftOriginalId = "";
let editorReadOnly = false;
let editorDirty = false;
let activeOperation = false;
let dragState = null;
const selectedProviderIds = new Set();
let bulkTargetGroup = "";

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setMessage(message, isError = false) {
  const node = document.getElementById("message");
  node.textContent = message || "";
  node.style.color = isError ? "#c2410c" : "";
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

function uniqueId(existingIds, base) {
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function pageProviderTemplate(existingConfigs) {
  const existingIds = new Set(existingConfigs.map((config) => config.id));
  const id = uniqueId(existingIds, `page-provider-${existingConfigs.length + 1}`);
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id,
    name: "新 Provider",
    group: "",
    type: "page",
    targetUrl: "",
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: false,
    secondaryUrls: [],
    mode: "page",
    parserRules: {
      loginHints: ["Login", "Sign in", "登录"],
      readySelector: "",
      balances: [],
      quotas: [],
      textMetrics: []
    }
  };
}

export function newApiProviderTemplate(existingConfigs) {
  const existingIds = new Set(existingConfigs.map((config) => config.id));
  const id = uniqueId(existingIds, `newapi-${existingConfigs.length + 1}`);
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id,
    name: "New API",
    group: "",
    type: "newapi",
    targetUrl: "",
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: false,
    secondaryUrls: [],
    mode: "api_then_page",
    parserRules: {
      loginHints: ["/login", "/user/login", "Sign in to", "Sign up", "用户登录", "登录账号", "登录 / 注册"],
      readyPattern: "额度|余额|用量|充值|quota|balance|usage|top up|token",
      balances: [
        {
          id: "newapi-balance",
          label: "剩余额度",
          pattern: "剩余额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
          valueGroup: 1,
          currency: "USD",
          limit: 1
        }
      ],
      quotas: [
        {
          id: "newapi-quota-usage",
          label: "额度用量",
          pattern: "已用额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*总额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
          usedGroup: 1,
          limitGroup: 2,
          currency: "USD",
          limit: 1
        }
      ],
      textMetrics: [
        {
          id: "newapi-request-count",
          label: "请求次数",
          pattern: "请求次数\\s*[:：]?\\s*(\\d+)",
          valueGroup: 1,
          limit: 1
        }
      ]
    }
  };
}

export function sub2ApiProviderTemplate(existingConfigs) {
  const existingIds = new Set(existingConfigs.map((config) => config.id));
  const id = uniqueId(existingIds, `sub2api-${existingConfigs.length + 1}`);
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id,
    name: "AIHub/Sub2API",
    group: "",
    type: "sub2api",
    targetUrl: "",
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: false,
    secondaryUrls: [],
    mode: "api_then_page",
    parserRules: {
      loginHints: ["/login", "登录", "用户登录", "Authorization header is required"],
      readyPattern: "余额|今日请求|总计|今日消费|累计 Token|balance|usage|dashboard|AIHub",
      balances: [
        {
          id: "sub2api-balance",
          label: "余额",
          pattern: "^\\$\\s*(\\d+(?:\\.\\d+)?)$",
          valueGroup: 1,
          currency: "USD",
          limit: 1
        }
      ],
      quotas: [],
      textMetrics: [
        {
          id: "sub2api-today-requests",
          label: "今日请求",
          pattern: "今日请求\\s*(\\d+)",
          valueGroup: 1,
          limit: 1
        }
      ]
    }
  };
}

export function duplicateProviderSource(config, existingConfigs) {
  const copied = clone(config);
  copied.schemaVersion = PROVIDER_SCHEMA_VERSION;
  copied.id = uniqueId(new Set(existingConfigs.map((item) => item.id)), `${config.id}-copy`);
  copied.name = `${config.name} Copy`;
  copied.refreshOnVisit = false;
  copied.parserRules ||= { loginHints: [], readySelector: "", balances: [], quotas: [], textMetrics: [] };
  return copied;
}

export function metricRuleTemplate(kind, existingRules = []) {
  const prefix = kind === "balances" ? "balance" : kind === "quotas" ? "quota" : "text";
  const id = uniqueId(new Set(existingRules.map((rule) => rule.id)), `${prefix}-${existingRules.length + 1}`);
  if (kind === "balances") {
    return { id, pageId: "main", label: "余额", selector: "", attribute: "textContent", index: 0, currency: "USD", valueGroup: 1 };
  }
  if (kind === "quotas") {
    return { id, pageId: "main", label: "用量", mode: "combined", selector: "", attribute: "textContent", index: 0, currency: "USD", usedGroup: 1, limitGroup: 2 };
  }
  return { id, pageId: "main", label: "指标", selector: "", attribute: "textContent", index: 0, valueGroup: 1 };
}

function setOperationLocked(locked) {
  activeOperation = locked;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = locked || button.dataset.layoutDisabled === "true";
  });
  document.querySelectorAll("[data-provider-select], [data-group-select]").forEach((input) => {
    input.disabled = locked;
  });
  const bulkSelect = document.getElementById("bulk-provider-group");
  if (bulkSelect) bulkSelect.disabled = locked;
}

async function withOperationLock(operation) {
  if (activeOperation) return null;
  setOperationLocked(true);
  try {
    return await operation();
  } finally {
    setOperationLocked(false);
  }
}

function confirmDiscardChanges() {
  return !editorDirty || confirm("当前来源有未保存的修改，确定放弃吗？");
}

function providerTypeLabel(config) {
  return isBuiltinProviderId(config.id) ? "内置" : "自定义";
}

function layoutButton(action, label, symbol, disabled = false) {
  const safeLabel = escapeHtml(label);
  return `<button type="button" class="icon-button" data-layout-action="${action}" data-layout-disabled="${disabled}" ${disabled ? "disabled" : ""} title="${safeLabel}" aria-label="${safeLabel}">${symbol}</button>`;
}

function selectedProviderCount() {
  const availableIds = new Set(configs.map((config) => config.id));
  for (const providerId of selectedProviderIds) {
    if (!availableIds.has(providerId)) selectedProviderIds.delete(providerId);
  }
  return selectedProviderIds.size;
}

function renderBulkActions() {
  const root = document.getElementById("provider-bulk-actions");
  const count = selectedProviderCount();
  root.classList.toggle("hidden", count === 0);
  document.getElementById("selected-provider-count").textContent = `已选择 ${count} 个`;

  const select = document.getElementById("bulk-provider-group");
  const groups = groupProviderConfigs(configs).filter((group) => group.name);
  select.innerHTML = [
    `<option value="">${UNGROUPED_PROVIDER_LABEL}</option>`,
    ...groups.map((group) => `<option value="${escapeHtml(group.name)}">${escapeHtml(group.label)}</option>`)
  ].join("");
  const availableGroups = new Set(["", ...groups.map((group) => group.name)]);
  if (!availableGroups.has(bulkTargetGroup)) bulkTargetGroup = "";
  select.value = bulkTargetGroup;
  select.disabled = activeOperation;
}

function updateGroupSelectionState(groupNode) {
  if (!groupNode) return;
  const providerInputs = [...groupNode.querySelectorAll("[data-provider-select]")];
  const selectedCount = providerInputs.filter((input) => input.checked).length;
  const groupInput = groupNode.querySelector("[data-group-select]");
  groupInput.checked = providerInputs.length > 0 && selectedCount === providerInputs.length;
  groupInput.indeterminate = selectedCount > 0 && selectedCount < providerInputs.length;
}

function renderProviderList() {
  const root = document.getElementById("providers");
  const groups = groupProviderConfigs(configs);
  root.innerHTML = groups.map((group, groupIndex) => `
    <div class="provider-group" data-provider-group="${escapeHtml(group.name)}">
      <div class="provider-group-head">
        <label class="selection-control group-selection">
          <input type="checkbox" data-group-select aria-label="选择 ${escapeHtml(group.label)} 分组中的所有 Provider">
          <span class="visually-hidden">选择 ${escapeHtml(group.label)} 分组</span>
        </label>
        <button type="button" class="drag-handle group-drag" draggable="true" data-drag-group title="拖动分组" aria-label="拖动 ${escapeHtml(group.label)} 分组">≡</button>
        <h3>${escapeHtml(group.label)}</h3>
        <span class="provider-count">${group.providers.length}</span>
        <div class="group-tools">
          ${group.name ? `<div class="group-actions">
            <button type="button" data-group-action="rename">重命名</button>
            <button type="button" data-group-action="delete">删除分组</button>
          </div>` : ""}
          <div class="layout-actions group-layout-actions">
            ${layoutButton("group-up", `上移 ${group.label} 分组`, "↑", groupIndex === 0)}
            ${layoutButton("group-down", `下移 ${group.label} 分组`, "↓", groupIndex === groups.length - 1)}
          </div>
        </div>
      </div>
      <div class="provider-group-list">
        ${group.providers.map((config, providerIndex) => {
          const builtin = isBuiltinProviderId(config.id);
          const selected = selectedProviderIds.has(config.id);
          return `<div class="provider-row ${selected ? "selected" : ""}" data-provider="${escapeHtml(config.id)}">
            <label class="selection-control provider-selection">
              <input type="checkbox" data-provider-select ${selected ? "checked" : ""} aria-label="选择 ${escapeHtml(config.name)}">
              <span class="visually-hidden">选择 ${escapeHtml(config.name)}</span>
            </label>
            <button type="button" class="drag-handle" draggable="true" data-provider-drag title="拖动排序" aria-label="拖动 ${escapeHtml(config.name)}">≡</button>
            <label class="checkbox-label">
              <input type="checkbox" data-provider-toggle ${config.enabled ? "checked" : ""}>
              启用
            </label>
            <div class="provider-summary">
              <div class="provider-title">
                <strong>${escapeHtml(config.name)}</strong>
                <span class="source-badge">${providerTypeLabel(config)}</span>
              </div>
              <div class="provider-url" title="${escapeHtml(config.targetUrl)}">${escapeHtml(config.targetUrl)}</div>
            </div>
            <div class="layout-actions provider-layout-actions">
              ${layoutButton("provider-up", `上移 ${config.name}`, "↑", providerIndex === 0)}
              ${layoutButton("provider-down", `下移 ${config.name}`, "↓", providerIndex === group.providers.length - 1)}
            </div>
            <div class="provider-actions">
              <button type="button" data-provider-action="edit">编辑</button>
              ${builtin ? '<button type="button" data-provider-action="duplicate">复制</button>' : ""}
              <button type="button" data-provider-action="test">测试</button>
              <button type="button" data-provider-action="export">导出</button>
              ${builtin ? "" : '<button type="button" data-provider-action="delete">删除</button>'}
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>`).join("");
  root.querySelectorAll("[data-provider-group]").forEach(updateGroupSelectionState);
  root.querySelectorAll("button").forEach((button) => {
    button.disabled = activeOperation || button.dataset.layoutDisabled === "true";
  });
  root.querySelectorAll("[data-provider-select], [data-group-select]").forEach((input) => {
    input.disabled = activeOperation;
  });
  renderBulkActions();
}

function configsWithCurrentToggles() {
  const toggles = new Map([...document.querySelectorAll(".provider-row")].map((row) => [
    row.dataset.provider,
    row.querySelector("[data-provider-toggle]")?.checked
  ]));
  return configs.map((config) => ({
    ...config,
    enabled: toggles.has(config.id) ? toggles.get(config.id) : config.enabled
  }));
}

async function persistProviderLayout(nextConfigs, message = "Provider 排序已保存。", { clearSelection = false } = {}) {
  return withOperationLock(async () => {
    try {
      const response = await sendMessage({ type: "config:save", configs: nextConfigs });
      configs = response.configs;
      if (clearSelection) selectedProviderIds.clear();
      renderProviderList();
      setMessage(message);
    } catch (error) {
      renderProviderList();
      setMessage(error.message || "保存 Provider 排序失败", true);
    }
  });
}

function validateGroupName(value, currentGroupName = "") {
  const name = String(value || "").trim();
  if (!name) {
    setMessage("分组名称不能为空。", true);
    return null;
  }
  if (name.length > 200) {
    setMessage("分组名称不能超过 200 个字符。", true);
    return null;
  }
  if (name === UNGROUPED_PROVIDER_LABEL) {
    setMessage(`“${UNGROUPED_PROVIDER_LABEL}”是保留名称。`, true);
    return null;
  }
  const duplicate = groupProviderConfigs(configs).some((group) => (
    group.name === name && group.name !== currentGroupName
  ));
  if (duplicate) {
    setMessage(`分组“${name}”已存在。`, true);
    return null;
  }
  return name;
}

function prepareForGroupManagement() {
  if (!confirmDiscardChanges()) return false;
  if (draftConfig) closeEditor(true);
  return true;
}

async function handleGroupAction(groupName, action) {
  if (!groupName) return;
  if (action === "rename") {
    const entered = prompt("新的分组名称", groupName);
    if (entered == null) return;
    const nextName = validateGroupName(entered, groupName);
    if (!nextName || nextName === groupName) return;
    if (!prepareForGroupManagement()) return;
    const sourceConfigs = configsWithCurrentToggles();
    await persistProviderLayout(
      renameProviderGroup(sourceConfigs, groupName, nextName),
      `分组“${groupName}”已重命名为“${nextName}”。`
    );
  }
  if (action === "delete") {
    if (!confirm(`删除分组“${groupName}”？其中的 Provider 将移至“${UNGROUPED_PROVIDER_LABEL}”。`)) return;
    if (!prepareForGroupManagement()) return;
    const sourceConfigs = configsWithCurrentToggles();
    await persistProviderLayout(
      deleteProviderGroup(sourceConfigs, groupName),
      `分组“${groupName}”已删除，其中的 Provider 已移至“${UNGROUPED_PROVIDER_LABEL}”。`
    );
  }
}

async function moveSelectedProviders() {
  if (!selectedProviderCount()) return;
  if (!prepareForGroupManagement()) return;
  const sourceConfigs = configsWithCurrentToggles();
  await persistProviderLayout(
    moveProvidersToGroup(sourceConfigs, selectedProviderIds, bulkTargetGroup),
    `${selectedProviderIds.size} 个 Provider 已移至“${bulkTargetGroup || UNGROUPED_PROVIDER_LABEL}”。`,
    { clearSelection: true }
  );
}

async function createGroupFromSelection() {
  if (!selectedProviderCount()) {
    setMessage("请先选择至少一个 Provider。", true);
    return;
  }
  const entered = prompt("新分组名称", "");
  if (entered == null) return;
  const groupName = validateGroupName(entered);
  if (!groupName) return;
  if (!prepareForGroupManagement()) return;
  const sourceConfigs = configsWithCurrentToggles();
  await persistProviderLayout(
    moveProvidersToGroup(sourceConfigs, selectedProviderIds, groupName),
    `已创建分组“${groupName}”，并移动 ${selectedProviderIds.size} 个 Provider。`,
    { clearSelection: true }
  );
}

function clearProviderSelection() {
  selectedProviderIds.clear();
  document.querySelectorAll("[data-provider-select], [data-group-select]").forEach((input) => {
    input.checked = false;
    input.indeterminate = false;
  });
  document.querySelectorAll(".provider-row.selected").forEach((row) => row.classList.remove("selected"));
  renderBulkActions();
}

function handleProviderSelectionChange(input) {
  const groupNode = input.closest("[data-provider-group]");
  if (input.matches("[data-group-select]")) {
    groupNode.querySelectorAll("[data-provider]").forEach((row) => {
      const providerId = row.dataset.provider;
      const providerInput = row.querySelector("[data-provider-select]");
      providerInput.checked = input.checked;
      row.classList.toggle("selected", input.checked);
      if (input.checked) selectedProviderIds.add(providerId);
      else selectedProviderIds.delete(providerId);
    });
  } else {
    const row = input.closest("[data-provider]");
    row.classList.toggle("selected", input.checked);
    if (input.checked) selectedProviderIds.add(row.dataset.provider);
    else selectedProviderIds.delete(row.dataset.provider);
  }
  updateGroupSelectionState(groupNode);
  renderBulkActions();
}

function applyLayoutAction(button) {
  const action = button.dataset.layoutAction;
  const sourceConfigs = configsWithCurrentToggles();
  const groupNode = button.closest("[data-provider-group]");
  const groupName = groupNode?.dataset.providerGroup ?? "";
  const groups = groupProviderConfigs(sourceConfigs);
  const groupIndex = groups.findIndex((group) => group.name === groupName);
  let nextConfigs = sourceConfigs;

  if (action === "group-up" || action === "group-down") {
    const offset = action === "group-up" ? -1 : 1;
    const target = groups[groupIndex + offset];
    if (!target) return;
    nextConfigs = moveProviderGroup(sourceConfigs, groupName, target.name, offset > 0);
  } else {
    const providerId = button.closest("[data-provider]")?.dataset.provider;
    const providers = groups[groupIndex]?.providers || [];
    const providerIndex = providers.findIndex((provider) => provider.id === providerId);
    const offset = action === "provider-up" ? -1 : 1;
    const target = providers[providerIndex + offset];
    if (!providerId || !target) return;
    nextConfigs = moveProvider(sourceConfigs, providerId, groupName, target.id, offset > 0);
  }
  persistProviderLayout(nextConfigs);
}

function clearDragState() {
  dragState = null;
  document.querySelectorAll(".dragging, .drop-target").forEach((node) => {
    node.classList.remove("dragging", "drop-target");
  });
}

function dragPlacement(event, target) {
  const bounds = target.getBoundingClientRect();
  return event.clientY > bounds.top + bounds.height / 2;
}

function handleLayoutDragStart(event) {
  const groupHandle = event.target.closest("[data-drag-group]");
  const providerHandle = event.target.closest("[data-provider-drag]");
  if (!groupHandle && !providerHandle) return;
  if (groupHandle) {
    const group = groupHandle.closest("[data-provider-group]");
    dragState = { kind: "group", groupName: group.dataset.providerGroup };
    group.classList.add("dragging");
  } else {
    const row = providerHandle.closest("[data-provider]");
    dragState = { kind: "provider", providerId: row.dataset.provider };
    row.classList.add("dragging");
  }
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragState.kind);
}

function handleLayoutDragOver(event) {
  if (!dragState) return;
  const target = dragState.kind === "provider"
    ? event.target.closest("[data-provider], [data-provider-group]")
    : event.target.closest("[data-provider-group]");
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
  target.classList.add("drop-target");
}

function handleLayoutDrop(event) {
  if (!dragState) return;
  event.preventDefault();
  const sourceConfigs = configsWithCurrentToggles();
  let nextConfigs = sourceConfigs;
  if (dragState.kind === "provider") {
    const targetRow = event.target.closest("[data-provider]");
    if (targetRow?.dataset.provider === dragState.providerId) {
      clearDragState();
      return;
    }
    const targetGroup = event.target.closest("[data-provider-group]");
    if (!targetGroup) return;
    nextConfigs = moveProvider(
      sourceConfigs,
      dragState.providerId,
      targetGroup.dataset.providerGroup,
      targetRow?.dataset.provider || null,
      targetRow ? dragPlacement(event, targetRow) : false
    );
  } else {
    const targetGroup = event.target.closest("[data-provider-group]");
    if (!targetGroup || targetGroup.dataset.providerGroup === dragState.groupName) {
      clearDragState();
      return;
    }
    nextConfigs = moveProviderGroup(
      sourceConfigs,
      dragState.groupName,
      targetGroup.dataset.providerGroup,
      dragPlacement(event, targetGroup)
    );
  }
  clearDragState();
  persistProviderLayout(nextConfigs);
}

function pageOptions(config, selectedPageId) {
  const pages = [
    { id: "main", label: "主页" },
    ...(config.secondaryUrls || []).map((page) => ({ id: page.id, label: page.label }))
  ];
  return pages.map((page) => `<option value="${escapeHtml(page.id)}" ${page.id === selectedPageId ? "selected" : ""}>${escapeHtml(page.label)}</option>`).join("");
}

function renderSecondaryPages(config) {
  return (config.secondaryUrls || []).map((page, index) => `<div class="page-row" data-page-index="${index}" data-page-id="${escapeHtml(page.id)}">
    <label>
      页面名称
      <input data-page-field="label" value="${escapeHtml(page.label)}" required>
    </label>
    <label>
      页面 URL
      <input data-page-field="url" type="url" value="${escapeHtml(page.url)}" required>
    </label>
    <button type="button" data-editor-action="remove-page" title="删除页面">删除</button>
  </div>`).join("");
}

function attributeOptions(selected) {
  return [
    ["textContent", "文本"],
    ["innerText", "可见文本"],
    ["value", "输入值"],
    ["href", "链接"],
    ["title", "标题属性"],
    ["aria-label", "ARIA 标签"]
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function currencyOptions(selected) {
  return ["USD", "CNY", "USDT"].map((currency) => `<option value="${currency}" ${currency === selected ? "selected" : ""}>${currency}</option>`).join("");
}

function renderBalanceRule(config, rule, index) {
  return `<div class="rule-card" data-rule-kind="balances" data-rule-index="${index}" data-rule-id="${escapeHtml(rule.id)}">
    <div class="rule-head"><h3>余额</h3><button type="button" data-editor-action="remove-rule">删除</button></div>
    <div class="rule-grid">
      <label>名称<input data-rule-field="label" value="${escapeHtml(rule.label || "余额")}" required></label>
      <label>页面<select data-rule-field="pageId">${pageOptions(config, rule.pageId || "main")}</select></label>
      <label class="wide">CSS 选择器<input data-rule-field="selector" value="${escapeHtml(rule.selector || "")}" spellcheck="false"></label>
      <label>币种<select data-rule-field="currency">${currencyOptions(rule.currency || "USD")}</select></label>
      <label>取值<select data-rule-field="attribute">${attributeOptions(rule.attribute || "textContent")}</select></label>
      <label>元素序号<input data-rule-field="index" type="number" min="0" value="${Number(rule.index ?? 0)}"></label>
      <details class="rule-advanced"><summary>正则提取</summary><div class="form-grid">
        <label>正则<input data-rule-field="pattern" value="${escapeHtml(rule.pattern || "")}" spellcheck="false"></label>
        <label>捕获组<input data-rule-field="valueGroup" type="number" min="0" value="${Number(rule.valueGroup ?? 1)}"></label>
      </div></details>
    </div>
  </div>`;
}

function renderQuotaRule(config, rule, index) {
  const mode = rule.mode || (rule.usedSelector || rule.limitSelector ? "separate" : "combined");
  return `<div class="rule-card" data-rule-kind="quotas" data-rule-index="${index}" data-rule-id="${escapeHtml(rule.id)}" data-quota-mode="${mode}">
    <div class="rule-head"><h3>额度</h3><button type="button" data-editor-action="remove-rule">删除</button></div>
    <div class="rule-grid">
      <label>名称<input data-rule-field="label" value="${escapeHtml(rule.label || "用量")}" required></label>
      <label>页面<select data-rule-field="pageId">${pageOptions(config, rule.pageId || "main")}</select></label>
      <label>取值方式<select data-rule-field="mode">
        <option value="combined" ${mode === "combined" ? "selected" : ""}>同一元素</option>
        <option value="separate" ${mode === "separate" ? "selected" : ""}>分别取值</option>
      </select></label>
      <label>币种<select data-rule-field="currency">${currencyOptions(rule.currency || "USD")}</select></label>
      <label class="wide quota-combined ${mode === "combined" ? "" : "hidden"}">CSS 选择器<input data-rule-field="selector" value="${escapeHtml(rule.selector || "")}" spellcheck="false"></label>
      <label class="quota-combined ${mode === "combined" ? "" : "hidden"}">取值<select data-rule-field="attribute">${attributeOptions(rule.attribute || "textContent")}</select></label>
      <label class="quota-combined ${mode === "combined" ? "" : "hidden"}">元素序号<input data-rule-field="index" type="number" min="0" value="${Number(rule.index ?? 0)}"></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">已用选择器<input data-rule-field="usedSelector" value="${escapeHtml(rule.usedSelector || "")}" spellcheck="false"></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">总额选择器<input data-rule-field="limitSelector" value="${escapeHtml(rule.limitSelector || "")}" spellcheck="false"></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">已用取值<select data-rule-field="usedAttribute">${attributeOptions(rule.usedAttribute || rule.attribute || "textContent")}</select></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">已用元素序号<input data-rule-field="usedIndex" type="number" min="0" value="${Number(rule.usedIndex ?? rule.index ?? 0)}"></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">总额取值<select data-rule-field="limitAttribute">${attributeOptions(rule.limitAttribute || rule.attribute || "textContent")}</select></label>
      <label class="quota-separate ${mode === "separate" ? "" : "hidden"}">总额元素序号<input data-rule-field="limitIndex" type="number" min="0" value="${Number(rule.limitIndex ?? rule.index ?? 0)}"></label>
      <label class="wide">重置时间选择器<input data-rule-field="resetSelector" value="${escapeHtml(rule.resetSelector || "")}" spellcheck="false"></label>
      <details class="rule-advanced"><summary>正则提取</summary><div class="form-grid">
        <label>正则<input data-rule-field="pattern" value="${escapeHtml(rule.pattern || "")}" spellcheck="false"></label>
        <label>已用捕获组<input data-rule-field="usedGroup" type="number" min="0" value="${Number(rule.usedGroup ?? 1)}"></label>
        <label>总额捕获组<input data-rule-field="limitGroup" type="number" min="0" value="${Number(rule.limitGroup ?? 2)}"></label>
        <label>重置正则<input data-rule-field="resetPattern" value="${escapeHtml(rule.resetPattern || "")}" spellcheck="false"></label>
      </div></details>
    </div>
  </div>`;
}

function renderTextRule(config, rule, index) {
  return `<div class="rule-card" data-rule-kind="textMetrics" data-rule-index="${index}" data-rule-id="${escapeHtml(rule.id)}">
    <div class="rule-head"><h3>文本</h3><button type="button" data-editor-action="remove-rule">删除</button></div>
    <div class="rule-grid">
      <label>名称<input data-rule-field="label" value="${escapeHtml(rule.label || "指标")}" required></label>
      <label>页面<select data-rule-field="pageId">${pageOptions(config, rule.pageId || "main")}</select></label>
      <label class="wide">CSS 选择器<input data-rule-field="selector" value="${escapeHtml(rule.selector || "")}" spellcheck="false"></label>
      <label>取值<select data-rule-field="attribute">${attributeOptions(rule.attribute || "textContent")}</select></label>
      <label>元素序号<input data-rule-field="index" type="number" min="0" value="${Number(rule.index ?? 0)}"></label>
      <details class="rule-advanced"><summary>正则提取</summary><div class="form-grid">
        <label>正则<input data-rule-field="pattern" value="${escapeHtml(rule.pattern || "")}" spellcheck="false"></label>
        <label>捕获组<input data-rule-field="valueGroup" type="number" min="0" value="${Number(rule.valueGroup ?? 1)}"></label>
      </div></details>
    </div>
  </div>`;
}

function renderMetricRules(config) {
  const rules = config.parserRules || {};
  const html = [
    ...(rules.balances || []).map((rule, index) => renderBalanceRule(config, rule, index)),
    ...(rules.quotas || []).map((rule, index) => renderQuotaRule(config, rule, index)),
    ...(rules.textMetrics || []).map((rule, index) => renderTextRule(config, rule, index))
  ].join("");
  return html || '<p class="empty-state">尚未添加指标规则。</p>';
}

function renderEditor() {
  if (!draftConfig) return;
  const section = document.getElementById("source-editor-section");
  const builtin = isBuiltinProviderId(draftConfig.id);
  const fixedAdapter = builtin || draftConfig.type === "newapi" || draftConfig.type === "sub2api";
  section.classList.remove("hidden");
  document.getElementById("editor-title").textContent = editorReadOnly
    ? `查看 ${draftConfig.name}`
    : draftOriginalId
      ? `编辑 ${draftConfig.name}`
      : "新增来源";
  document.getElementById("source-name").value = draftConfig.name || "";
  document.getElementById("source-id").value = draftConfig.id || "";
  document.getElementById("source-group").value = draftConfig.group || "";
  document.getElementById("provider-groups").innerHTML = groupProviderConfigs(configs)
    .filter((group) => group.name)
    .map((group) => `<option value="${escapeHtml(group.name)}"></option>`)
    .join("");
  document.getElementById("source-enabled").checked = draftConfig.enabled !== false;
  document.getElementById("source-refresh-on-visit").checked = draftConfig.refreshOnVisit === true;
  document.getElementById("source-type").value = draftConfig.type || "page";
  document.getElementById("source-target-url").value = draftConfig.targetUrl || "";
  document.getElementById("source-recharge-ratio").value = draftConfig.rechargeRatio ?? 1;
  document.getElementById("deepseek-credentials-block").classList.toggle(
    "hidden",
    draftConfig.id !== "deepseek" || editorReadOnly
  );
  document.getElementById("secondary-pages").innerHTML = renderSecondaryPages(draftConfig);
  document.getElementById("metric-rules").innerHTML = renderMetricRules(draftConfig);
  document.getElementById("source-login-hints").value = (draftConfig.parserRules?.loginHints || []).join("\n");
  document.getElementById("source-ready-selector").value = draftConfig.parserRules?.readySelector || "";
  document.getElementById("builtin-editor-note").classList.toggle("hidden", !builtin || editorReadOnly);
  document.getElementById("metric-rules-block").classList.toggle("hidden", fixedAdapter);
  document.getElementById("advanced-block").classList.toggle("hidden", fixedAdapter);
  const form = document.getElementById("source-form");
  form.querySelectorAll("input, select, textarea").forEach((control) => {
    control.disabled = editorReadOnly;
  });
  // Built-in id/type are fixed; existing custom sources keep a stable id.
  document.getElementById("source-id").disabled = Boolean(draftOriginalId) || editorReadOnly || builtin;
  form.querySelectorAll('[data-editor-action^="add-"], [data-editor-action="remove-page"], [data-editor-action="remove-rule"]').forEach((button) => {
    button.classList.toggle("hidden", editorReadOnly);
  });
  form.querySelector('button[type="submit"]').classList.toggle("hidden", editorReadOnly);
  document.getElementById("delete-source").classList.toggle("hidden", editorReadOnly || !draftOriginalId || builtin);
  document.getElementById("test-preview").classList.add("hidden");
  form.querySelectorAll("button").forEach((button) => { button.disabled = activeOperation; });
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function optionalField(object, key, value) {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized !== "" && normalized != null) object[key] = normalized;
}

function readRule(card) {
  const fields = Object.fromEntries([...card.querySelectorAll("[data-rule-field]")]
    .map((control) => [control.dataset.ruleField, control.value]));
  return [card.dataset.ruleKind, ruleFormValuesToRule(card.dataset.ruleKind, card.dataset.ruleId, fields)];
}

export function ruleFormValuesToRule(kind, id, fields) {
  const value = (field) => fields[field] ?? "";
  const rule = {
    id,
    pageId: value("pageId") || "main",
    label: value("label").trim()
  };
  optionalField(rule, "pattern", value("pattern"));
  if (kind === "balances") {
    optionalField(rule, "selector", value("selector"));
    rule.attribute = value("attribute") || "textContent";
    rule.index = Number(value("index") || 0);
    rule.currency = value("currency") || "USD";
    rule.valueGroup = Number(value("valueGroup") || 1);
  } else if (kind === "quotas") {
    rule.mode = value("mode") || "combined";
    if (rule.mode === "separate") {
      optionalField(rule, "usedSelector", value("usedSelector"));
      optionalField(rule, "limitSelector", value("limitSelector"));
      rule.usedAttribute = value("usedAttribute") || "textContent";
      rule.usedIndex = Number(value("usedIndex") || 0);
      rule.limitAttribute = value("limitAttribute") || "textContent";
      rule.limitIndex = Number(value("limitIndex") || 0);
    } else {
      optionalField(rule, "selector", value("selector"));
      rule.attribute = value("attribute") || "textContent";
      rule.index = Number(value("index") || 0);
    }
    optionalField(rule, "resetSelector", value("resetSelector"));
    optionalField(rule, "resetPattern", value("resetPattern"));
    rule.currency = value("currency") || "USD";
    rule.usedGroup = Number(value("usedGroup") || 1);
    rule.limitGroup = Number(value("limitGroup") || 2);
  } else {
    optionalField(rule, "selector", value("selector"));
    rule.attribute = value("attribute") || "textContent";
    rule.index = Number(value("index") || 0);
    rule.valueGroup = Number(value("valueGroup") || 1);
  }
  return rule;
}

export function formStateToProvider(state) {
  return normalizeProviderConfig(state);
}

function readEditorSource() {
  const secondaryUrls = [...document.querySelectorAll("#secondary-pages .page-row")].map((row) => ({
    id: row.dataset.pageId,
    label: row.querySelector('[data-page-field="label"]').value.trim(),
    url: row.querySelector('[data-page-field="url"]').value.trim()
  }));
  const builtin = isBuiltinProviderId(draftConfig?.id || document.getElementById("source-id").value.trim());
  const base = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: document.getElementById("source-id").value.trim(),
    name: document.getElementById("source-name").value.trim(),
    group: document.getElementById("source-group").value.trim(),
    type: document.getElementById("source-type").value || draftConfig?.type || "page",
    targetUrl: document.getElementById("source-target-url").value.trim(),
    rechargeRatio: Number(document.getElementById("source-recharge-ratio").value),
    enabled: document.getElementById("source-enabled").checked,
    refreshOnVisit: document.getElementById("source-refresh-on-visit").checked,
    secondaryUrls,
    mode: draftConfig?.mode || "page"
  };
  if (builtin) {
    return {
      ...base,
      type: draftConfig?.type || base.type,
      mode: draftConfig?.mode || base.mode
    };
  }
  const groupedRules = { balances: [], quotas: [], textMetrics: [] };
  document.querySelectorAll("#metric-rules .rule-card").forEach((card) => {
    const [kind, rule] = readRule(card);
    groupedRules[kind].push(rule);
  });
  const parserRules = {
    ...clone(draftConfig?.parserRules || {}),
    loginHints: document.getElementById("source-login-hints").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    balances: groupedRules.balances,
    quotas: groupedRules.quotas,
    textMetrics: groupedRules.textMetrics
  };
  const readySelector = document.getElementById("source-ready-selector").value.trim();
  if (readySelector) parserRules.readySelector = readySelector;
  else delete parserRules.readySelector;
  return { ...base, parserRules };
}

function openEditor(config, options = {}) {
  draftConfig = clone(config);
  draftOriginalId = options.isNew ? "" : config.id;
  editorReadOnly = Boolean(options.readOnly);
  document.getElementById("deepseek-key").value = "";
  renderEditor();
  editorDirty = false;
}

function closeEditor(force = false) {
  if (!force && !confirmDiscardChanges()) return false;
  draftConfig = null;
  draftOriginalId = "";
  editorReadOnly = false;
  editorDirty = false;
  document.getElementById("source-editor-section").classList.add("hidden");
  return true;
}

function mutateDraft(mutator) {
  draftConfig = readEditorSource();
  mutator(draftConfig);
  renderEditor();
  editorDirty = true;
}

function addSecondaryPage() {
  mutateDraft((config) => {
    const ids = new Set((config.secondaryUrls || []).map((page) => page.id));
    const id = uniqueId(ids, `page-${(config.secondaryUrls || []).length + 1}`);
    config.secondaryUrls.push({ id, label: "详情页", url: "" });
  });
}

function removeSecondaryPage(button) {
  const row = button.closest(".page-row");
  const removedPageId = row.dataset.pageId;
  mutateDraft((config) => {
    config.secondaryUrls = config.secondaryUrls.filter((page) => page.id !== removedPageId);
    for (const rules of [config.parserRules.balances, config.parserRules.quotas, config.parserRules.textMetrics]) {
      for (const rule of rules) if (rule.pageId === removedPageId) rule.pageId = "main";
    }
  });
}

function addMetricRule(kind) {
  mutateDraft((config) => {
    const allRules = [
      ...(config.parserRules.balances || []),
      ...(config.parserRules.quotas || []),
      ...(config.parserRules.textMetrics || [])
    ];
    const rule = metricRuleTemplate(kind, allRules);
    config.parserRules[kind].push(rule);
  });
}

function removeMetricRule(button) {
  const card = button.closest(".rule-card");
  mutateDraft((config) => {
    config.parserRules[card.dataset.ruleKind] = config.parserRules[card.dataset.ruleKind]
      .filter((rule) => rule.id !== card.dataset.ruleId);
  });
}

function updateQuotaMode(select) {
  const card = select.closest(".rule-card");
  const separate = select.value === "separate";
  card.dataset.quotaMode = select.value;
  card.querySelectorAll(".quota-combined").forEach((node) => node.classList.toggle("hidden", separate));
  card.querySelectorAll(".quota-separate").forEach((node) => node.classList.toggle("hidden", !separate));
}

function validateSelectors(config) {
  const rules = config.parserRules || {};
  const selectors = [
    rules.readySelector,
    ...(rules.balances || []).flatMap((rule) => [rule.selector]),
    ...(rules.quotas || []).flatMap((rule) => [rule.selector, rule.usedSelector, rule.limitSelector, rule.resetSelector]),
    ...(rules.textMetrics || []).flatMap((rule) => [rule.selector])
  ].filter(Boolean);
  for (const selector of selectors) {
    try {
      document.querySelector(selector);
    } catch (error) {
      throw new Error(`CSS 选择器无效：${selector}（${error.message}）`);
    }
  }
}

async function requestProviderPermissions(config) {
  return requestOrigins(originsForConfig(config));
}

async function requestOrigins(origins) {
  if (!chrome.permissions?.request) return;
  const uniqueOrigins = [...new Set(origins)];
  if (!await chrome.permissions.request({ origins: uniqueOrigins })) {
    throw new Error(`未获得站点访问权限：${uniqueOrigins.join("、")}`);
  }
}

function previewMetric(label, value) {
  return `<div class="preview-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatBalancePreview(item) {
  if (item.currency === "CNY") return `¥${item.value}`;
  if (item.currency === "USD") return `$${item.value}`;
  return item.currency ? `${item.value} ${item.currency}` : item.value;
}

function diagnosticHtml(item) {
  const status = ({ matched: "已匹配", not_found: "未找到元素", parse_failed: "正则解析失败" })[item.status] || item.status;
  const samples = (item.samples || []).map((sample) => `<code>${escapeHtml(sample)}</code>`).join("");
  return `<div class="diagnostic ${escapeHtml(item.status)}">
    <div><strong>${escapeHtml(item.label || item.ruleId)}</strong><span>${escapeHtml(status)}</span></div>
    <small>${escapeHtml(item.pageId || "main")} · ${Number(item.matchCount || 0)} 个元素${item.error ? ` · ${escapeHtml(item.error)}` : ""}</small>
    ${samples ? `<div class="diagnostic-samples">${samples}</div>` : ""}
  </div>`;
}

function renderTestPreview(snapshot) {
  const root = document.getElementById("test-preview");
  const metricKeys = new Set([...(snapshot.balances || []), ...(snapshot.usage || [])].map((item) => item.key));
  const textMetrics = (snapshot.metrics || []).filter((item) => !metricKeys.has(item.key));
  const rows = [
    ...(snapshot.balances || []).map((item) => previewMetric(item.label, formatBalancePreview(item))),
    ...(snapshot.usage || []).map((item) => previewMetric(item.label, item.value || `${item.percent}%`)),
    ...textMetrics.map((item) => previewMetric(item.label, item.value))
  ].join("");
  root.innerHTML = `<div class="preview-head"><strong>${escapeHtml(snapshot.name)}</strong><span>${escapeHtml(snapshot.status)}</span></div>
    ${rows || '<div class="preview-error">没有匹配到指标</div>'}
    ${snapshot.error ? `<div class="preview-error">${escapeHtml(snapshot.error)}</div>` : ""}
    ${(snapshot.diagnostics || []).length ? `<div class="diagnostics">${snapshot.diagnostics.map(diagnosticHtml).join("")}</div>` : ""}`;
  root.classList.remove("hidden");
}

function renderTesting() {
  const root = document.getElementById("test-preview");
  root.innerHTML = "正在测试...";
  root.classList.remove("hidden");
}

async function saveEditor(event) {
  event?.preventDefault();
  return withOperationLock(async () => {
    try {
    if (!document.getElementById("source-form").reportValidity()) return;
    const raw = readEditorSource();
    const source = isBuiltinProviderId(raw.id)
      ? formStateToProvider({
          ...raw,
          type: draftConfig?.type || raw.type,
          mode: draftConfig?.mode || raw.mode
        })
      : formStateToProvider(raw);
    if (!isBuiltinProviderId(source.id)) validateSelectors(source);
    await requestProviderPermissions(source);
    const deepSeekKey = source.id === "deepseek"
      ? document.getElementById("deepseek-key").value.trim()
      : "";
    if (deepSeekKey) {
      await sendMessage({ type: "secret:setDeepSeekKey", value: deepSeekKey });
    }
    const response = await sendMessage({ type: "config:saveProvider", provider: source });
    await load();
    openEditor(response.provider);
    setMessage(`${source.name} 已保存。`);
    } catch (error) {
      setMessage(error.message || "保存失败", true);
    }
  });
}

async function testEditor() {
  return withOperationLock(async () => {
    try {
    const source = formStateToProvider(readEditorSource());
    validateSelectors(source);
    await requestProviderPermissions(source);
    renderTesting();
    const response = await sendMessage({ type: "providers:test", provider: source });
    renderTestPreview(response.provider);
    setMessage("测试完成，结果不会写入看板缓存。");
    } catch (error) {
      const root = document.getElementById("test-preview");
      root.innerHTML = `<div class="preview-error">${escapeHtml(error.message || String(error))}</div>`;
      root.classList.remove("hidden");
      setMessage(error.message || "测试失败", true);
    }
  });
}

async function deleteProvider(providerId) {
  const config = configs.find((item) => item.id === providerId);
  if (!config || isBuiltinProviderId(providerId)) return;
  if (!confirm(`删除 Provider：${config.name}？`)) return;
  return withOperationLock(async () => {
    try {
    await sendMessage({ type: "config:deleteProvider", providerId });
    closeEditor(true);
    await load();
    setMessage(`${config.name} 已删除。`);
    } catch (error) {
      setMessage(error.message || "删除失败", true);
    }
  });
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportSource(providerId) {
  return withOperationLock(async () => {
    try {
    const response = await sendMessage({ type: "config:exportProvider", providerId });
    const json = JSON.stringify(response.provider, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setMessage(`${response.provider.name} Provider 配置已复制。`);
    } catch {
      downloadJson(response.provider, `${response.provider.id}.provider.json`);
      setMessage(`${response.provider.name} Provider 配置已下载。`);
    }
    } catch (error) {
      setMessage(error.message || "导出失败", true);
    }
  });
}

async function exportAllSources() {
  return withOperationLock(async () => {
    try {
    const response = await sendMessage({ type: "config:get" });
    const sources = (response.configs || []).filter((config) => !isBuiltinProviderId(config.id));
    if (!sources.length) throw new Error("没有可导出的自定义 Provider。");
    const json = JSON.stringify(sources, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setMessage(`已复制 ${sources.length} 个自定义 Provider。`);
    } catch {
      downloadJson(sources, "providers.provider.json");
      setMessage(`已下载 ${sources.length} 个自定义 Provider。`);
    }
    } catch (error) {
      setMessage(error.message || "导出全部失败", true);
    }
  });
}

async function handleProviderAction(providerId, action) {
  const config = configs.find((item) => item.id === providerId);
  if (!config) return;
  if (["edit", "view", "duplicate", "test"].includes(action) && !confirmDiscardChanges()) return;
  if (action === "edit") openEditor(config);
  if (action === "view") openEditor(config, { readOnly: true });
  if (action === "duplicate") openEditor(duplicateProviderSource(config, configs), { isNew: true });
  if (action === "export") await exportSource(providerId);
  if (action === "delete") await deleteProvider(providerId);
  if (action === "test") {
    openEditor(config);
    await testEditor();
  }
}

async function importSources() {
  return withOperationLock(async () => {
    try {
    const parsed = JSON.parse(document.getElementById("import-json").value);
    const sources = Array.isArray(parsed) ? parsed : [parsed];
    if (!sources.length) throw new Error("Provider 配置文件为空。");
    const normalizedSources = sources.map((raw) => {
      const source = formStateToProvider(raw);
      validateSelectors(source);
      return source;
    });
    const sourceIds = new Set();
    for (const source of normalizedSources) {
      if (sourceIds.has(source.id)) throw new Error(`导入文件包含重复 ID：${source.id}`);
      sourceIds.add(source.id);
    }
    await requestOrigins(normalizedSources.flatMap(originsForConfig));
    const response = await sendMessage({ type: "config:importProviders", providers: normalizedSources });
    const imported = response.providers.at(-1);
    await load();
    document.getElementById("import-panel").classList.add("hidden");
    document.getElementById("import-json").value = "";
    if (imported) openEditor(imported);
    setMessage(`已导入 ${sources.length} 个 Provider。`);
    } catch (error) {
      setMessage(error.message || "导入失败", true);
    }
  });
}

function formatAutoRefreshMeta(settings) {
  const minutes = Number(settings?.autoRefreshMinutes || 0);
  if (!minutes) return "后台自动刷新已关闭。可随时在弹窗里手动刷新。";
  if (settings?.lastAutoRefreshError) {
    const attempted = settings.lastAutoRefreshAttemptAt
      ? new Date(settings.lastAutoRefreshAttemptAt).toLocaleString()
      : "未知时间";
    return `后台刷新失败（${attempted}）：${settings.lastAutoRefreshError}`;
  }
  const last = settings?.lastAutoRefreshAt
    ? `最近自动刷新：${new Date(settings.lastAutoRefreshAt).toLocaleString()}`
    : "尚未执行过自动刷新";
  const policy = ({
    "reuse-open-tabs": "仅复用已打开页面",
    "api-only": "仅使用 API / HTTP",
    "allow-hidden-tabs": "允许创建后台标签页"
  })[settings?.autoRefreshTabPolicy] || "仅复用已打开页面";
  return `已启用：每 ${minutes} 分钟刷新已启用的 provider，${policy}，并更新工具栏角标。${last}。`;
}

function applySettingsToForm(settings) {
  const select = document.getElementById("auto-refresh-minutes");
  if (select) select.value = String(settings?.autoRefreshMinutes ?? 30);
  const tabPolicy = document.getElementById("auto-refresh-tab-policy");
  if (tabPolicy) tabPolicy.value = settings?.autoRefreshTabPolicy || "reuse-open-tabs";
  const meta = document.getElementById("auto-refresh-meta");
  if (meta) meta.textContent = formatAutoRefreshMeta(settings);
}

async function saveGlobal() {
  return withOperationLock(async () => {
    try {
    const updatedConfigs = configsWithCurrentToggles();
    const configResponse = await sendMessage({ type: "config:save", configs: updatedConfigs });
    const settingsResponse = await sendMessage({
      type: "settings:save",
      settings: {
        autoRefreshMinutes: Number(document.getElementById("auto-refresh-minutes").value || 0),
        autoRefreshTabPolicy: document.getElementById("auto-refresh-tab-policy").value
      }
    });
    configs = configResponse.configs;
    renderProviderList();
    applySettingsToForm(settingsResponse.settings);
    const interval = settingsResponse.settings?.autoRefreshMinutes || 0;
    setMessage(interval
      ? `全局设置已保存。后台将每 ${interval} 分钟自动刷新。`
      : "全局设置已保存。后台自动刷新已关闭。");
    } catch (error) {
      setMessage(error.message || "保存失败", true);
    }
  });
}

async function clearDeepSeekKey() {
  return withOperationLock(async () => {
    try {
      await sendMessage({ type: "secret:clearDeepSeekKey" });
      document.getElementById("deepseek-key").value = "";
      setMessage("DeepSeek 密钥已清除。");
    } catch (error) {
      setMessage(error.message || "清除密钥失败", true);
    }
  });
}

async function load() {
  const [configData, settingsData] = await Promise.all([
    sendMessage({ type: "config:get" }),
    sendMessage({ type: "settings:get" })
  ]);
  configs = configData.configs;
  renderProviderList();
  applySettingsToForm(settingsData.settings);
}

function handleEditorAction(button) {
  const action = button.dataset.editorAction;
  if (action === "add-page") addSecondaryPage();
  if (action === "remove-page") removeSecondaryPage(button);
  if (action === "add-balance") addMetricRule("balances");
  if (action === "add-quota") addMetricRule("quotas");
  if (action === "add-text") addMetricRule("textMetrics");
  if (action === "remove-rule") removeMetricRule(button);
  if (action === "test") testEditor();
}

if (typeof document !== "undefined") {
  document.getElementById("save-global").addEventListener("click", saveGlobal);
  document.getElementById("clear-deepseek-key").addEventListener("click", clearDeepSeekKey);
  document.getElementById("add-page-provider").addEventListener("click", () => {
    if (confirmDiscardChanges()) openEditor(pageProviderTemplate(configs), { isNew: true });
  });
  document.getElementById("add-newapi-provider").addEventListener("click", () => {
    if (confirmDiscardChanges()) openEditor(newApiProviderTemplate(configs), { isNew: true });
  });
  document.getElementById("add-sub2api-provider").addEventListener("click", () => {
    if (confirmDiscardChanges()) openEditor(sub2ApiProviderTemplate(configs), { isNew: true });
  });
  document.getElementById("close-editor").addEventListener("click", closeEditor);
  document.getElementById("source-form").addEventListener("submit", saveEditor);
  document.getElementById("delete-source").addEventListener("click", () => deleteProvider(draftOriginalId));
  document.getElementById("providers").addEventListener("click", (event) => {
    const layoutButton = event.target.closest("[data-layout-action]");
    if (layoutButton) {
      applyLayoutAction(layoutButton);
      return;
    }
    const groupButton = event.target.closest("[data-group-action]");
    if (groupButton) {
      handleGroupAction(groupButton.closest("[data-provider-group]").dataset.providerGroup, groupButton.dataset.groupAction);
      return;
    }
    const button = event.target.closest("[data-provider-action]");
    if (button) handleProviderAction(button.closest("[data-provider]").dataset.provider, button.dataset.providerAction);
  });
  document.getElementById("providers").addEventListener("change", (event) => {
    if (event.target.matches("[data-provider-select], [data-group-select]")) {
      handleProviderSelectionChange(event.target);
    }
  });
  document.getElementById("providers").addEventListener("dragstart", handleLayoutDragStart);
  document.getElementById("providers").addEventListener("dragover", handleLayoutDragOver);
  document.getElementById("providers").addEventListener("drop", handleLayoutDrop);
  document.getElementById("providers").addEventListener("dragend", clearDragState);
  document.getElementById("source-form").addEventListener("click", (event) => {
    const button = event.target.closest("[data-editor-action]");
    if (button) handleEditorAction(button);
  });
  document.getElementById("source-form").addEventListener("change", (event) => {
    if (event.target.matches('[data-rule-field="mode"]')) updateQuotaMode(event.target);
    if (!editorReadOnly) editorDirty = true;
  });
  document.getElementById("source-form").addEventListener("input", () => {
    if (!editorReadOnly) editorDirty = true;
  });
  document.getElementById("import-source").addEventListener("click", () => {
    if (!confirmDiscardChanges()) return;
    if (draftConfig) closeEditor(true);
    document.getElementById("import-panel").classList.remove("hidden");
  });
  document.getElementById("export-all-sources").addEventListener("click", exportAllSources);
  document.getElementById("bulk-provider-group").addEventListener("change", (event) => {
    bulkTargetGroup = event.target.value;
  });
  document.getElementById("move-selected-providers").addEventListener("click", moveSelectedProviders);
  document.getElementById("create-provider-group").addEventListener("click", createGroupFromSelection);
  document.getElementById("clear-provider-selection").addEventListener("click", clearProviderSelection);
  document.getElementById("close-import").addEventListener("click", () => document.getElementById("import-panel").classList.add("hidden"));
  document.getElementById("choose-import-file").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (file) document.getElementById("import-json").value = await file.text();
  });
  document.getElementById("confirm-import").addEventListener("click", importSources);
  window.addEventListener("beforeunload", (event) => {
    if (!editorDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  load().catch((error) => setMessage(error.message, true));
}
