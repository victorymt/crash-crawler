import { normalizeProviderConfig, originsForConfig } from "../shared/config.js";
import { badgeFromSnapshots, blankSnapshot, errorSnapshot } from "../shared/snapshots.js";
import {
  exportProviderConfig,
  deleteProviderConfig,
  getExtensionSettings,
  getProviderConfigs,
  getSnapshots,
  importProviderConfig,
  importProviderConfigs,
  markAutoRefreshCompleted,
  markAutoRefreshFailed,
  markAutoRefreshStarted,
  deleteSecret,
  saveExtensionSettings,
  saveProviderConfig,
  saveProviderConfigs,
  saveSnapshot,
  saveSnapshots,
  setSecret
} from "../shared/storage.js";
import { collectProvider, isApiProvider } from "../providers/index.js";

/** Cap concurrent page collectors to avoid opening too many tabs at once. */
const REFRESH_CONCURRENCY = 4;
export const AUTO_REFRESH_ALARM = "providers:autoRefresh";

/** Prevent overlapping full refreshes (manual + alarm). */
let refreshAllInFlight = null;
const providerRefreshes = new Map();

async function publicConfigs() {
  return (await getProviderConfigs()).filter((config) => config.enabled);
}

async function updateActionBadge(snapshots) {
  if (!globalThis.chrome?.action?.setBadgeText) return;
  const badge = badgeFromSnapshots(snapshots);
  await chrome.action.setBadgeText({ text: badge.text });
  if (chrome.action.setBadgeBackgroundColor) {
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  }
  if (chrome.action.setTitle) {
    await chrome.action.setTitle({ title: badge.title });
  }
}

async function syncBadgeFromStorage() {
  const [configs, snapshots] = await Promise.all([getProviderConfigs(), getSnapshots()]);
  const enabled = configs.filter((config) => config.enabled);
  const list = enabled.map((config) => snapshots[config.id] || blankSnapshot(config));
  await updateActionBadge(list);
}

async function listProviders() {
  const configs = await publicConfigs();
  const snapshots = await getSnapshots();
  const settings = await getExtensionSettings();
  const providers = configs.map((config) => snapshots[config.id] || blankSnapshot(config));
  return { providers, configs, settings };
}

async function collectOne(config, previousSnapshot) {
  try {
    return await collectProvider(config);
  } catch (error) {
    return errorSnapshot(config, previousSnapshot, error);
  }
}

async function collectOneExclusive(config, previousSnapshot) {
  const existing = providerRefreshes.get(config.id);
  if (existing) return existing;
  const refresh = collectOne(config, previousSnapshot).finally(() => {
    if (providerRefreshes.get(config.id) === refresh) providerRefreshes.delete(config.id);
  });
  providerRefreshes.set(config.id, refresh);
  return refresh;
}

async function removeUnusedOptionalOrigins(previousConfigs, nextConfigs) {
  if (!globalThis.chrome?.permissions?.remove) return;
  const nextOrigins = new Set(nextConfigs.flatMap(originsForConfig));
  const staleOrigins = [...new Set(previousConfigs.flatMap(originsForConfig))]
    .filter((origin) => !nextOrigins.has(origin));
  await Promise.all(staleOrigins.map(async (origin) => {
    try {
      await chrome.permissions.remove({ origins: [origin] });
    } catch {
      // Required manifest origins cannot be removed and are safe to retain.
    }
  }));
}

async function mutateConfigs(work) {
  const previous = await getProviderConfigs();
  const value = await work();
  const next = await getProviderConfigs();
  await removeUnusedOptionalOrigins(previous, next);
  return value;
}

async function refreshProvider(providerId) {
  const configs = await getProviderConfigs();
  const config = configs.find((item) => item.id === providerId);
  if (!config) throw new Error(`unknown provider: ${providerId}`);
  const snapshots = await getSnapshots();
  const snapshot = await collectOneExclusive(config, snapshots[providerId]);
  const saved = await saveSnapshot(snapshot);
  await syncBadgeFromStorage();
  return saved;
}

async function testProvider(providerInput) {
  const configs = await getProviderConfigs();
  const config = typeof providerInput === "string"
    ? configs.find((item) => item.id === providerInput)
    : normalizeProviderConfig(providerInput);
  if (!config) throw new Error(`unknown provider: ${providerInput}`);
  return collectProvider(config);
}

async function mapPool(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function refreshAllProviders() {
  const configs = await publicConfigs();
  const previous = await getSnapshots();
  // API providers finish independently; page tabs share a concurrency pool.
  const apiConfigs = configs.filter((config) => isApiProvider(config));
  const pageConfigs = configs.filter((config) => !isApiProvider(config));
  const byId = new Map();

  await Promise.all(apiConfigs.map(async (config) => {
    byId.set(config.id, await collectOneExclusive(config, previous[config.id]));
  }));

  await mapPool(pageConfigs, REFRESH_CONCURRENCY, async (config) => {
    const snapshot = await collectOneExclusive(config, previous[config.id]);
    byId.set(config.id, snapshot);
    return snapshot;
  });

  const providers = configs.map((config) => byId.get(config.id)).filter(Boolean);
  await saveSnapshots(providers);
  await updateActionBadge(providers);
  return providers;
}

async function refreshAllProvidersExclusive() {
  if (refreshAllInFlight) return refreshAllInFlight;
  refreshAllInFlight = refreshAllProviders()
    .finally(() => {
      refreshAllInFlight = null;
    });
  return refreshAllInFlight;
}

export async function syncAutoRefreshAlarm(settingsInput) {
  if (!globalThis.chrome?.alarms?.create) return null;
  const settings = settingsInput || await getExtensionSettings();
  await chrome.alarms.clear(AUTO_REFRESH_ALARM);
  if (!settings.autoRefreshMinutes) return { enabled: false, periodMinutes: 0 };
  // First fire after one full period so enabling does not immediately open tabs.
  await chrome.alarms.create(AUTO_REFRESH_ALARM, {
    delayInMinutes: settings.autoRefreshMinutes,
    periodInMinutes: settings.autoRefreshMinutes
  });
  return { enabled: true, periodMinutes: settings.autoRefreshMinutes };
}

async function runAutoRefresh() {
  await markAutoRefreshStarted();
  try {
    const providers = await refreshAllProvidersExclusive();
    const settings = await markAutoRefreshCompleted();
    return { providers, settings };
  } catch (error) {
    await markAutoRefreshFailed(error);
    throw error;
  }
}

async function bootstrap() {
  await syncBadgeFromStorage();
  await syncAutoRefreshAlarm();
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get("providerConfigs");
  if (!Array.isArray(data.providerConfigs)) {
    await saveProviderConfigs((await getProviderConfigs()).map(normalizeProviderConfig));
  }
  // Persist defaults so options/UI can read a concrete interval after install.
  await saveExtensionSettings(await getExtensionSettings());
  await bootstrap();
});

chrome.runtime.onStartup?.addListener?.(() => {
  bootstrap().catch(() => undefined);
});

if (globalThis.chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== AUTO_REFRESH_ALARM) return;
    runAutoRefresh().catch(() => undefined);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "providers:list":
        return listProviders();
      case "providers:refresh":
        return { provider: await refreshProvider(message.providerId) };
      case "providers:refreshAll":
        return { providers: await refreshAllProvidersExclusive() };
      case "settings:get":
        return { settings: await getExtensionSettings() };
      case "settings:save": {
        const settings = await saveExtensionSettings(message.settings || {});
        const alarm = await syncAutoRefreshAlarm(settings);
        return { settings, alarm };
      }
      case "config:get":
        return { configs: await getProviderConfigs() };
      case "config:save": {
        const configs = await mutateConfigs(() => saveProviderConfigs(message.configs || []));
        await syncBadgeFromStorage();
        return { configs };
      }
      case "config:saveProvider": {
        const provider = await mutateConfigs(() => saveProviderConfig(message.provider));
        await syncBadgeFromStorage();
        return { provider };
      }
      case "config:importProvider": {
        const provider = await mutateConfigs(() => importProviderConfig(message.provider));
        await syncBadgeFromStorage();
        return { provider };
      }
      case "config:importProviders": {
        const providers = await mutateConfigs(() => importProviderConfigs(message.providers));
        await syncBadgeFromStorage();
        return { providers };
      }
      case "config:deleteProvider": {
        const configs = await mutateConfigs(() => deleteProviderConfig(message.providerId));
        await syncBadgeFromStorage();
        return { configs };
      }
      case "config:exportProvider":
        return { provider: await exportProviderConfig(message.providerId) };
      case "providers:test":
        return { provider: await testProvider(message.provider || message.providerId) };
      case "secret:setDeepSeekKey":
        if (message.value) {
          await setSecret("deepseekApiKey", message.value);
        }
        return { ok: true };
      case "secret:clearDeepSeekKey":
        await deleteSecret("deepseekApiKey");
        return { ok: true };
      default:
        throw new Error(`unknown message type: ${message?.type}`);
    }
  };
  run().then(
    (value) => sendResponse({ ok: true, ...value }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true;
});
