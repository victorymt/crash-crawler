import {
  PROVIDER_SCHEMA_VERSION,
  isBuiltinProviderId,
  normalizeProviderConfig,
  originsForConfig
} from "../shared/config.js";

let configs = [];
let draftConfig = null;
let draftOriginalId = "";
let editorReadOnly = false;
let editorDirty = false;
let activeOperation = false;

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
    type: "page",
    targetUrl: "",
    enabled: true,
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

export function duplicateProviderSource(config, existingConfigs) {
  const copied = clone(config);
  copied.schemaVersion = PROVIDER_SCHEMA_VERSION;
  copied.id = uniqueId(new Set(existingConfigs.map((item) => item.id)), `${config.id}-copy`);
  copied.name = `${config.name} Copy`;
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
  document.querySelectorAll("button").forEach((button) => { button.disabled = locked; });
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

function renderProviderList() {
  const root = document.getElementById("providers");
  root.innerHTML = configs.map((config) => {
    const builtin = isBuiltinProviderId(config.id);
    return `<div class="provider-row" data-provider="${escapeHtml(config.id)}">
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
      <div class="provider-actions">
        <button type="button" data-provider-action="${builtin ? "view" : "edit"}">${builtin ? "查看" : "编辑"}</button>
        ${builtin ? '<button type="button" data-provider-action="duplicate">复制</button>' : ""}
        <button type="button" data-provider-action="test">测试</button>
        <button type="button" data-provider-action="export">导出</button>
        ${builtin ? "" : '<button type="button" data-provider-action="delete">删除</button>'}
      </div>
    </div>`;
  }).join("");
  root.querySelectorAll("button").forEach((button) => { button.disabled = activeOperation; });
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
  section.classList.remove("hidden");
  document.getElementById("editor-title").textContent = editorReadOnly ? `查看 ${draftConfig.name}` : draftOriginalId ? `编辑 ${draftConfig.name}` : "新增来源";
  document.getElementById("source-name").value = draftConfig.name || "";
  document.getElementById("source-id").value = draftConfig.id || "";
  document.getElementById("source-enabled").checked = draftConfig.enabled !== false;
  document.getElementById("source-type").value = draftConfig.type || "page";
  document.getElementById("source-target-url").value = draftConfig.targetUrl || "";
  document.getElementById("secondary-pages").innerHTML = renderSecondaryPages(draftConfig);
  document.getElementById("metric-rules").innerHTML = renderMetricRules(draftConfig);
  document.getElementById("source-login-hints").value = (draftConfig.parserRules?.loginHints || []).join("\n");
  document.getElementById("source-ready-selector").value = draftConfig.parserRules?.readySelector || "";
  const form = document.getElementById("source-form");
  form.querySelectorAll("input, select, textarea").forEach((control) => {
    control.disabled = editorReadOnly;
  });
  document.getElementById("source-id").disabled = Boolean(draftOriginalId) || editorReadOnly;
  form.querySelectorAll('[data-editor-action^="add-"], [data-editor-action="remove-page"], [data-editor-action="remove-rule"]').forEach((button) => {
    button.classList.toggle("hidden", editorReadOnly);
  });
  form.querySelector('button[type="submit"]').classList.toggle("hidden", editorReadOnly);
  document.getElementById("delete-source").classList.toggle("hidden", editorReadOnly || !draftOriginalId);
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
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: document.getElementById("source-id").value.trim(),
    name: document.getElementById("source-name").value.trim(),
    type: document.getElementById("source-type").value || "page",
    targetUrl: document.getElementById("source-target-url").value.trim(),
    enabled: document.getElementById("source-enabled").checked,
    secondaryUrls,
    mode: draftConfig?.mode || "page",
    parserRules
  };
}

function openEditor(config, options = {}) {
  draftConfig = clone(config);
  draftOriginalId = options.isNew ? "" : config.id;
  editorReadOnly = Boolean(options.readOnly);
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
    const source = formStateToProvider(readEditorSource());
    validateSelectors(source);
    await requestProviderPermissions(source);
    const response = await sendMessage({ type: "config:importProvider", provider: source });
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

function downloadJson(provider) {
  const blob = new Blob([JSON.stringify(provider, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${provider.id}.provider.json`;
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
      setMessage(`${response.provider.name} 书源已复制。`);
    } catch {
      downloadJson(response.provider);
      setMessage(`${response.provider.name} 书源已下载。`);
    }
    } catch (error) {
      setMessage(error.message || "导出失败", true);
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
    openEditor(config, { readOnly: isBuiltinProviderId(providerId) });
    await testEditor();
  }
}

async function importSources() {
  return withOperationLock(async () => {
    try {
    const parsed = JSON.parse(document.getElementById("import-json").value);
    const sources = Array.isArray(parsed) ? parsed : [parsed];
    if (!sources.length) throw new Error("书源文件为空。");
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

async function saveGlobal() {
  return withOperationLock(async () => {
    try {
    const updatedConfigs = configs.map((config) => {
      const row = [...document.querySelectorAll(".provider-row")].find((item) => item.dataset.provider === config.id);
      return { ...config, enabled: row?.querySelector("[data-provider-toggle]").checked ?? config.enabled };
    });
    await sendMessage({ type: "config:save", configs: updatedConfigs });
    await sendMessage({
      type: "secret:setDeepSeekKey",
      value: document.getElementById("deepseek-key").value.trim()
    });
    configs = updatedConfigs;
    renderProviderList();
    setMessage("全局设置已保存。断开的站点权限会在测试或保存来源时重新申请。");
    } catch (error) {
      setMessage(error.message || "保存失败", true);
    }
  });
}

async function load() {
  const data = await sendMessage({ type: "config:get" });
  configs = data.configs;
  renderProviderList();
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
  document.getElementById("add-page-provider").addEventListener("click", () => {
    if (confirmDiscardChanges()) openEditor(pageProviderTemplate(configs), { isNew: true });
  });
  document.getElementById("close-editor").addEventListener("click", closeEditor);
  document.getElementById("source-form").addEventListener("submit", saveEditor);
  document.getElementById("delete-source").addEventListener("click", () => deleteProvider(draftOriginalId));
  document.getElementById("providers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-provider-action]");
    if (button) handleProviderAction(button.closest("[data-provider]").dataset.provider, button.dataset.providerAction);
  });
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
