const LOCAL_SYNC_SETTINGS_KEY = "localSyncSettings";
export const DEFAULT_LOCAL_SYNC_SETTINGS = {
  url: "http://127.0.0.1:19765",
  token: ""
};

function normalizeUrl(value) {
  const parsed = new URL(String(value || DEFAULT_LOCAL_SYNC_SETTINGS.url).trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("本地 Web 地址必须使用 http 或 https");
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("同步地址只能是 localhost 或本机回环地址");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeLocalSyncSettings(raw = {}) {
  return {
    url: normalizeUrl(raw.url || DEFAULT_LOCAL_SYNC_SETTINGS.url),
    token: String(raw.token || "").trim().slice(0, 256)
  };
}

export async function getLocalSyncSettings() {
  const data = await chrome.storage.local.get(LOCAL_SYNC_SETTINGS_KEY);
  return normalizeLocalSyncSettings(data[LOCAL_SYNC_SETTINGS_KEY]);
}

export async function saveLocalSyncSettings(raw) {
  const settings = normalizeLocalSyncSettings(raw);
  await chrome.storage.local.set({ [LOCAL_SYNC_SETTINGS_KEY]: settings });
  return settings;
}

export async function requestLocalSyncPermission(baseUrl) {
  const parsed = new URL(normalizeUrl(baseUrl));
  const origin = `${parsed.protocol}//${parsed.host}/*`;
  if (!chrome.permissions?.request) return true;
  return chrome.permissions.request({ origins: [origin] });
}

export async function localSyncRequest(rawSettings, path, options = {}) {
  const settings = normalizeLocalSyncSettings(rawSettings);
  if (!settings.token) throw new Error("请先填写本地 Web 配对令牌");
  const response = await fetch(`${settings.url}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Provider-Sync-Token": settings.token,
      ...(options.headers || {})
    }
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || `本地 Web 请求失败（HTTP ${response.status}）`);
  return data;
}
