import { DEFAULT_PROVIDER_CONFIGS, normalizeProviderConfig } from "./config.js";

const CONFIG_KEY = "providerConfigs";
const SNAPSHOT_KEY = "providerSnapshots";
const SECRETS_KEY = "secrets";

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

export async function getProviderConfigs() {
  const data = await storageGet(CONFIG_KEY);
  const configs = Array.isArray(data[CONFIG_KEY]) ? data[CONFIG_KEY] : DEFAULT_PROVIDER_CONFIGS;
  return configs.map(normalizeProviderConfig);
}

export async function saveProviderConfigs(configs) {
  const normalized = configs.map(normalizeProviderConfig);
  await storageSet({ [CONFIG_KEY]: normalized });
  return normalized;
}

export async function getSnapshots() {
  const data = await storageGet(SNAPSHOT_KEY);
  return data[SNAPSHOT_KEY] && typeof data[SNAPSHOT_KEY] === "object" ? data[SNAPSHOT_KEY] : {};
}

export async function saveSnapshot(snapshot) {
  const snapshots = await getSnapshots();
  snapshots[snapshot.id] = snapshot;
  await storageSet({ [SNAPSHOT_KEY]: snapshots });
  return snapshot;
}

export async function getSecret(name) {
  const data = await storageGet(SECRETS_KEY);
  return data[SECRETS_KEY]?.[name] || "";
}

export async function setSecret(name, value) {
  const data = await storageGet(SECRETS_KEY);
  const secrets = data[SECRETS_KEY] && typeof data[SECRETS_KEY] === "object" ? data[SECRETS_KEY] : {};
  secrets[name] = value;
  await storageSet({ [SECRETS_KEY]: secrets });
}
