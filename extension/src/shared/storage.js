import {
  DEFAULT_PROVIDER_CONFIGS,
  isBuiltinProviderId,
  normalizeProviderConfig,
  normalizeProviderConfigs
} from "./config.js";

const CONFIG_KEY = "providerConfigs";
const SNAPSHOT_KEY = "providerSnapshots";
const SECRETS_KEY = "secrets";

function normalizeStoredConfigs(configs) {
  const rawConfigs = Array.isArray(configs) ? configs : [];
  const builtins = DEFAULT_PROVIDER_CONFIGS.map((defaultConfig) => {
    const stored = rawConfigs.find((item) => item?.id === defaultConfig.id);
    return { ...defaultConfig, enabled: stored?.enabled ?? defaultConfig.enabled };
  });
  const custom = rawConfigs.filter((item) => item && !isBuiltinProviderId(item.id));
  return normalizeProviderConfigs([...builtins, ...custom]);
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

export async function getProviderConfigs() {
  const data = await storageGet(CONFIG_KEY);
  return normalizeStoredConfigs(data[CONFIG_KEY]);
}

export async function saveProviderConfigs(configs) {
  const normalized = normalizeStoredConfigs(configs);
  await storageSet({ [CONFIG_KEY]: normalized });
  return normalized;
}

export async function importProviderConfig(provider) {
  const [imported] = await importProviderConfigs([provider]);
  return imported;
}

export async function importProviderConfigs(providers) {
  if (!Array.isArray(providers) || !providers.length) throw new Error("Provider import is empty");
  const ids = new Set();
  const imported = providers.map((provider) => {
    const normalized = normalizeProviderConfig(provider);
    if (isBuiltinProviderId(normalized.id)) {
      throw new Error(`Built-in provider cannot be replaced: ${normalized.id}`);
    }
    if (ids.has(normalized.id)) throw new Error(`Duplicate provider id in import: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  const configs = await getProviderConfigs();
  const replacements = new Map(imported.map((provider) => [provider.id, provider]));
  const merged = configs.map((config) => replacements.get(config.id) || config);
  for (const provider of imported) {
    if (!configs.some((config) => config.id === provider.id)) merged.push(provider);
  }
  const normalized = normalizeProviderConfigs(merged);
  await storageSet({ [CONFIG_KEY]: normalized });
  return imported.map((provider) => normalized.find((item) => item.id === provider.id));
}

export async function deleteProviderConfig(providerId) {
  const id = String(providerId || "");
  if (isBuiltinProviderId(id)) throw new Error(`Built-in provider cannot be deleted: ${id}`);
  const [configs, snapshots] = await Promise.all([getProviderConfigs(), getSnapshots()]);
  if (!configs.some((config) => config.id === id)) throw new Error(`unknown provider: ${id}`);
  const nextSnapshots = { ...snapshots };
  delete nextSnapshots[id];
  const normalized = normalizeStoredConfigs(configs.filter((config) => config.id !== id));
  await storageSet({ [CONFIG_KEY]: normalized, [SNAPSHOT_KEY]: nextSnapshots });
  return normalized;
}

export async function exportProviderConfig(providerId) {
  const configs = await getProviderConfigs();
  const config = configs.find((item) => item.id === providerId);
  if (!config) throw new Error(`unknown provider: ${providerId}`);
  return normalizeProviderConfig(config);
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
