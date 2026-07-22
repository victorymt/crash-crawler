let configs = [];

function sendMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    return response;
  });
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

export function pageProviderTemplate(existingConfigs) {
  let suffix = existingConfigs.length + 1;
  let id = `page-provider-${suffix}`;
  const existingIds = new Set(existingConfigs.map((config) => config.id));
  while (existingIds.has(id)) {
    suffix += 1;
    id = `page-provider-${suffix}`;
  }
  return {
    id,
    name: "New Page Provider",
    type: "page",
    targetUrl: "https://example.com/dashboard",
    enabled: true,
    secondaryUrls: [],
    parserRules: {
      loginHints: ["Login", "Sign in", "登录"],
      readyPattern: "余额|用量|后重置",
      balances: [
        {
          label: "余额",
          pattern: "^[$](\\d+(?:\\.\\d+)?)$",
          valueGroup: 1,
          currency: "USD",
          limit: 1
        }
      ],
      quotas: [
        {
          label: "每周用量",
          pattern: "^[$](\\d+(?:\\.\\d+)?)\\s*/\\s*[$](\\d+(?:\\.\\d+)?)$",
          usedGroup: 1,
          limitGroup: 2,
          currency: "USD",
          resetPattern: "(.+?)\\s*后重置"
        }
      ],
      textMetrics: [
        {
          label: "到期时间",
          pattern: "剩余\\s*[^()]*\\(([^)]+)\\)",
          valueGroup: 1
        }
      ]
    }
  };
}

function render() {
  const root = document.getElementById("providers");
  root.innerHTML = configs.map((config) => `<div class="provider-row" data-provider="${escapeHtml(config.id)}">
    <label class="checkbox-label">
      <input type="checkbox" data-field="enabled" ${config.enabled ? "checked" : ""}>
      启用
    </label>
    <label>
      名称
      <input data-field="name" value="${escapeHtml(config.name)}">
    </label>
    <label>
      URL
      <input data-field="targetUrl" value="${escapeHtml(config.targetUrl)}">
    </label>
  </div>`).join("");
  document.getElementById("configs-json").value = JSON.stringify(configs, null, 2);
}

function parseJsonConfigs() {
  const parsed = JSON.parse(document.getElementById("configs-json").value);
  if (!Array.isArray(parsed)) {
    throw new Error("高级 JSON 配置必须是 provider 数组。");
  }
  return parsed;
}

function readBasicOverrides() {
  return new Map(configs.map((config) => {
    const row = document.querySelector(`[data-provider="${CSS.escape(config.id)}"]`);
    const enabled = row.querySelector('[data-field="enabled"]').checked;
    const name = row.querySelector('[data-field="name"]').value.trim() || config.id;
    const targetUrl = row.querySelector('[data-field="targetUrl"]').value.trim();
    const override = {};
    if (enabled !== config.enabled) override.enabled = enabled;
    if (name !== config.name) override.name = name;
    if (targetUrl !== config.targetUrl) override.targetUrl = targetUrl;
    return [config.id, override];
  }));
}

function readConfigsFromForm() {
  const parsed = parseJsonConfigs();
  const overrides = readBasicOverrides();
  return parsed.map((config) => ({
    ...config,
    ...(overrides.get(config.id) || {})
  }));
}

function addPageProvider() {
  try {
    const parsed = parseJsonConfigs();
    parsed.push(pageProviderTemplate(parsed));
    document.getElementById("configs-json").value = JSON.stringify(parsed, null, 2);
    setMessage("已添加页面 Provider 模板，编辑 URL 和 parserRules 后保存。");
  } catch (error) {
    setMessage(error.message || "添加失败", true);
  }
}

async function load() {
  const data = await sendMessage({ type: "config:get" });
  configs = data.configs;
  render();
}

async function save() {
  try {
    const updatedConfigs = readConfigsFromForm();
    for (const config of updatedConfigs) {
      new URL(config.targetUrl);
    }
    await sendMessage({ type: "config:save", configs: updatedConfigs });
    await sendMessage({
      type: "secret:setDeepSeekKey",
      value: document.getElementById("deepseek-key").value.trim()
    });
    configs = updatedConfigs;
    render();
    setMessage("设置已保存。");
  } catch (error) {
    setMessage(error.message || "保存失败", true);
  }
}

if (typeof document !== "undefined") {
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("add-page-provider").addEventListener("click", addPageProvider);
  load().catch((error) => setMessage(error.message, true));
}
