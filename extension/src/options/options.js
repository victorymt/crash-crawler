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
}

function readConfigsFromForm() {
  return configs.map((config) => {
    const row = document.querySelector(`[data-provider="${CSS.escape(config.id)}"]`);
    return {
      ...config,
      enabled: row.querySelector('[data-field="enabled"]').checked,
      name: row.querySelector('[data-field="name"]').value.trim() || config.id,
      targetUrl: row.querySelector('[data-field="targetUrl"]').value.trim()
    };
  });
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
    setMessage("设置已保存。");
  } catch (error) {
    setMessage(error.message || "保存失败", true);
  }
}

document.getElementById("save").addEventListener("click", save);
load().catch((error) => setMessage(error.message, true));
