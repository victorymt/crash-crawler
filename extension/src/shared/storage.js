import {
  DEFAULT_PROVIDER_CONFIGS,
  isBuiltinProviderId,
  normalizeProviderConfig,
  normalizeProviderConfigs
} from "./config.js";
import { TAB_POLICIES, TAB_POLICY_VALUES } from "../providers/runtime.js";

const CONFIG_KEY = "providerConfigs";
const SNAPSHOT_KEY = "providerSnapshots";
const SECRETS_KEY = "secrets";
const SETTINGS_KEY = "extensionSettings";

let storageMutationChain = Promise.resolve();

function withStorageMutationLock(work) {
  const run = storageMutationChain.then(work, work);
  storageMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 0 disables background refresh. Chrome alarms require period >= 1 minute. */
export const AUTO_REFRESH_MINUTES_OPTIONS = [0, 15, 30, 60, 120, 360];
export const DEFAULT_EXTENSION_SETTINGS = {
  autoRefreshMinutes: 30,
  autoRefreshTabPolicy: TAB_POLICIES.REUSE_OPEN_TABS,
  preferredChannelModel: "",
  lastAutoRefreshAt: null,
  lastAutoRefreshAttemptAt: null,
  lastAutoRefreshError: null
};

export function normalizeExtensionSettings(raw = {}) {
  const minutes = Number(raw?.autoRefreshMinutes);
  return {
    autoRefreshMinutes: AUTO_REFRESH_MINUTES_OPTIONS.includes(minutes)
      ? minutes
      : DEFAULT_EXTENSION_SETTINGS.autoRefreshMinutes,
    autoRefreshTabPolicy: TAB_POLICY_VALUES.includes(raw?.autoRefreshTabPolicy)
      ? raw.autoRefreshTabPolicy
      : DEFAULT_EXTENSION_SETTINGS.autoRefreshTabPolicy,
    preferredChannelModel: raw?.preferredChannelModel
      ? String(raw.preferredChannelModel).slice(0, 160)
      : "",
    lastAutoRefreshAt: raw?.lastAutoRefreshAt ? String(raw.lastAutoRefreshAt) : null,
    lastAutoRefreshAttemptAt: raw?.lastAutoRefreshAttemptAt ? String(raw.lastAutoRefreshAttemptAt) : null,
    lastAutoRefreshError: raw?.lastAutoRefreshError ? String(raw.lastAutoRefreshError).slice(0, 500) : null
  };
}

/**
 * Built-ins keep type/mode/id fixed, but users may customize
 * name, group, targetUrl, secondaryUrls, and enabled (e.g. OpenCode workspace).
 */
export function mergeBuiltinConfig(defaultConfig, stored) {
  if (!stored || typeof stored !== "object") {
    return normalizeProviderConfig(defaultConfig);
  }
  const secondaryUrls = Array.isArray(stored.secondaryUrls)
    ? stored.secondaryUrls
    : Array.isArray(stored.secondary_urls)
      ? stored.secondary_urls
      : defaultConfig.secondaryUrls;
  const name = stored.name != null && String(stored.name).trim() !== ""
    ? String(stored.name)
    : defaultConfig.name;
  const targetUrl = stored.targetUrl || stored.target_url || defaultConfig.targetUrl;
  return normalizeProviderConfig({
    ...defaultConfig,
    id: defaultConfig.id,
    type: defaultConfig.type,
    mode: defaultConfig.mode,
    enabled: stored.enabled ?? defaultConfig.enabled,
    refreshOnVisit: stored.refreshOnVisit ?? defaultConfig.refreshOnVisit,
    rechargeRatio: stored.rechargeRatio ?? stored.recharge_ratio ?? defaultConfig.rechargeRatio,
    group: stored.group ?? defaultConfig.group ?? "",
    name,
    targetUrl,
    secondaryUrls
  });
}

function normalizeStoredConfigs(configs) {
  const rawConfigs = Array.isArray(configs) ? configs : [];
  const builtinDefaults = new Map(DEFAULT_PROVIDER_CONFIGS.map((config) => [config.id, config]));
  const seenBuiltins = new Set();
  const ordered = [];
  for (const rawConfig of rawConfigs) {
    if (!rawConfig || typeof rawConfig !== "object") continue;
    const defaultConfig = builtinDefaults.get(rawConfig.id);
    if (!defaultConfig) {
      ordered.push(rawConfig);
      continue;
    }
    if (seenBuiltins.has(defaultConfig.id)) continue;
    seenBuiltins.add(defaultConfig.id);
    ordered.push(mergeBuiltinConfig(defaultConfig, rawConfig));
  }
  for (const defaultConfig of DEFAULT_PROVIDER_CONFIGS) {
    if (!seenBuiltins.has(defaultConfig.id)) ordered.push(mergeBuiltinConfig(defaultConfig, null));
  }
  return normalizeProviderConfigs(ordered);
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
  return withStorageMutationLock(async () => {
    const normalized = normalizeStoredConfigs(configs);
    await storageSet({ [CONFIG_KEY]: normalized });
    return normalized;
  });
}

/** Upsert one provider: builtins merge editable fields; custom replaces fully. */
export async function saveProviderConfig(provider) {
  return withStorageMutationLock(async () => {
    const configs = await getProviderConfigs();
    if (isBuiltinProviderId(provider?.id)) {
      const defaults = DEFAULT_PROVIDER_CONFIGS.find((item) => item.id === provider.id);
      if (!defaults) throw new Error(`unknown provider: ${provider.id}`);
      const next = configs.map((config) => (
        config.id === provider.id ? mergeBuiltinConfig(defaults, provider) : config
      ));
      const normalized = normalizeStoredConfigs(next);
      await storageSet({ [CONFIG_KEY]: normalized });
      return normalized.find((item) => item.id === provider.id);
    }
    const normalizedProvider = normalizeProviderConfig(provider);
    const index = configs.findIndex((item) => item.id === normalizedProvider.id);
    const next = [...configs];
    if (index >= 0) next[index] = normalizedProvider;
    else next.push(normalizedProvider);
    const normalized = normalizeStoredConfigs(next);
    await storageSet({ [CONFIG_KEY]: normalized });
    return normalized.find((item) => item.id === normalizedProvider.id);
  });
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
  return withStorageMutationLock(async () => {
    const configs = await getProviderConfigs();
    const replacements = new Map(imported.map((provider) => [provider.id, provider]));
    const merged = configs.map((config) => replacements.get(config.id) || config);
    for (const provider of imported) {
      if (!configs.some((config) => config.id === provider.id)) merged.push(provider);
    }
    const normalized = normalizeProviderConfigs(merged);
    await storageSet({ [CONFIG_KEY]: normalized });
    return imported.map((provider) => normalized.find((item) => item.id === provider.id));
  });
}

export async function deleteProviderConfig(providerId) {
  return withStorageMutationLock(async () => {
    const id = String(providerId || "");
    if (isBuiltinProviderId(id)) throw new Error(`Built-in provider cannot be deleted: ${id}`);
    const [configs, snapshots] = await Promise.all([getProviderConfigs(), getSnapshots()]);
    if (!configs.some((config) => config.id === id)) throw new Error(`unknown provider: ${id}`);
    const nextSnapshots = { ...snapshots };
    delete nextSnapshots[id];
    const normalized = normalizeStoredConfigs(configs.filter((config) => config.id !== id));
    await storageSet({ [CONFIG_KEY]: normalized, [SNAPSHOT_KEY]: nextSnapshots });
    return normalized;
  });
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

function snapshotTime(snapshot) {
  const value = Date.parse(snapshot?.checkedAt || snapshot?.updatedAt || "");
  return Number.isFinite(value) ? value : null;
}

function shouldReplaceSnapshot(current, next) {
  if (!current) return true;
  const currentTime = snapshotTime(current);
  const nextTime = snapshotTime(next);
  return currentTime == null || nextTime == null || nextTime >= currentTime;
}

export async function saveSnapshot(snapshot) {
  return withStorageMutationLock(async () => {
    const snapshots = await getSnapshots();
    if (!shouldReplaceSnapshot(snapshots[snapshot.id], snapshot)) return snapshots[snapshot.id];
    snapshots[snapshot.id] = snapshot;
    await storageSet({ [SNAPSHOT_KEY]: snapshots });
    return snapshot;
  });
}

export async function saveSnapshots(snapshotList) {
  if (!Array.isArray(snapshotList) || !snapshotList.length) return [];
  return withStorageMutationLock(async () => {
    const snapshots = await getSnapshots();
    for (const snapshot of snapshotList) {
      if (snapshot?.id && shouldReplaceSnapshot(snapshots[snapshot.id], snapshot)) snapshots[snapshot.id] = snapshot;
    }
    await storageSet({ [SNAPSHOT_KEY]: snapshots });
    return snapshotList;
  });
}

/**
 * Save refresh results only for providers that still exist when the storage
 * transaction commits. This prevents an in-flight refresh from recreating a
 * snapshot after its provider has been deleted.
 */
export async function saveCurrentProviderSnapshot(snapshot) {
  const [saved] = await saveCurrentProviderSnapshots([snapshot]);
  return saved;
}

export async function saveCurrentProviderSnapshots(snapshotList) {
  if (!Array.isArray(snapshotList) || !snapshotList.length) return [];
  return withStorageMutationLock(async () => {
    const [configs, snapshots] = await Promise.all([getProviderConfigs(), getSnapshots()]);
    const currentIds = new Set(configs.map((config) => config.id));
    const saved = [];
    for (const snapshot of snapshotList) {
      if (!snapshot?.id || !currentIds.has(snapshot.id)) continue;
      if (!shouldReplaceSnapshot(snapshots[snapshot.id], snapshot)) {
        saved.push(snapshots[snapshot.id]);
        continue;
      }
      snapshots[snapshot.id] = snapshot;
      saved.push(snapshot);
    }
    if (saved.length) await storageSet({ [SNAPSHOT_KEY]: snapshots });
    return saved;
  });
}

export async function getSecret(name) {
  const data = await storageGet(SECRETS_KEY);
  return data[SECRETS_KEY]?.[name] || "";
}

export async function setSecret(name, value) {
  return withStorageMutationLock(async () => {
    const data = await storageGet(SECRETS_KEY);
    const secrets = data[SECRETS_KEY] && typeof data[SECRETS_KEY] === "object" ? data[SECRETS_KEY] : {};
    secrets[name] = value;
    await storageSet({ [SECRETS_KEY]: secrets });
  });
}

export async function deleteSecret(name) {
  return withStorageMutationLock(async () => {
    const data = await storageGet(SECRETS_KEY);
    const secrets = data[SECRETS_KEY] && typeof data[SECRETS_KEY] === "object" ? { ...data[SECRETS_KEY] } : {};
    delete secrets[name];
    await storageSet({ [SECRETS_KEY]: secrets });
  });
}

export async function getExtensionSettings() {
  const data = await storageGet(SETTINGS_KEY);
  return normalizeExtensionSettings(data[SETTINGS_KEY]);
}

export async function saveExtensionSettings(settings) {
  return withStorageMutationLock(async () => {
    const current = await getExtensionSettings();
    const normalized = normalizeExtensionSettings({ ...current, ...settings });
    await storageSet({ [SETTINGS_KEY]: normalized });
    return normalized;
  });
}

export async function markAutoRefreshCompleted(at = new Date().toISOString()) {
  return saveExtensionSettings({
    lastAutoRefreshAt: at,
    lastAutoRefreshAttemptAt: at,
    lastAutoRefreshError: null
  });
}

export async function markAutoRefreshStarted(at = new Date().toISOString()) {
  return saveExtensionSettings({ lastAutoRefreshAttemptAt: at, lastAutoRefreshError: null });
}

export async function markAutoRefreshFailed(error, at = new Date().toISOString()) {
  return saveExtensionSettings({
    lastAutoRefreshAttemptAt: at,
    lastAutoRefreshError: error?.message || String(error || "Auto refresh failed")
  });
}
