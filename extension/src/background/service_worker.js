import { normalizeProviderConfig } from "../shared/config.js";
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
  saveCurrentProviderSnapshot,
  setSecret
} from "../shared/storage.js";
import { collectProvider } from "../providers/index.js";
import { clearProviderSessionHints } from "../providers/session_cache.js";
import { recoverRefreshRun, runRefreshBatch } from "./refresh_runner.js";
import { configsForObservedUrl, syncVisitObserver } from "./visit_observer.js";

export const AUTO_REFRESH_ALARM = "providers:autoRefresh";

/** Keep full refreshes serialized so they cannot overwrite one session job. */
let refreshAllFlight = null;
const providerRefreshes = new Map();
const observedRefreshTimes = new Map();
let configMutationChain = Promise.resolve();
const OBSERVED_REFRESH_THROTTLE_MS = 15_000;

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

async function collectOne(config, previousSnapshot, context = {}) {
  try {
    return await collectProvider(config, context);
  } catch (error) {
    return errorSnapshot(config, previousSnapshot, error);
  }
}

function contextCapability(context = {}) {
  if (context.tabPolicy === "allow-hidden-tabs") return 2;
  if (context.tabPolicy === "reuse-open-tabs") return 1;
  return 0;
}

async function collectOneExclusive(config, previousSnapshot, context = {}) {
  const existing = providerRefreshes.get(config.id);
  const capability = contextCapability(context);
  if (existing) {
    if (existing.capability >= capability) return existing.promise;
    try {
      await existing.promise;
    } catch {
      // A more capable refresh should still get its own attempt.
    }
    return collectOneExclusive(config, previousSnapshot, context);
  }
  const refresh = collectOne(config, previousSnapshot, context).finally(() => {
    if (providerRefreshes.get(config.id)?.promise === refresh) providerRefreshes.delete(config.id);
  });
  providerRefreshes.set(config.id, { promise: refresh, capability });
  return refresh;
}

async function mutateConfigs(work) {
  // Keep the whole logical mutation ordered, not just its storage write. Host
  // permissions are intentionally retained: permission requests happen in an
  // options-page user gesture, so asynchronously revoking a "stale" origin
  // here can race with another options page granting it for a new config.
  const run = configMutationChain.then(work);
  configMutationChain = run.then(() => undefined, () => undefined);
  return run;
}

async function refreshProvider(providerId) {
  const configs = await getProviderConfigs();
  const config = configs.find((item) => item.id === providerId);
  if (!config) throw new Error(`unknown provider: ${providerId}`);
  const snapshots = await getSnapshots();
  const snapshot = await collectOneExclusive(config, snapshots[providerId], {
    trigger: "manual",
    tabPolicy: "allow-hidden-tabs"
  });
  const saved = await saveCurrentProviderSnapshot(snapshot);
  if (!saved) throw new Error(`provider was deleted while refreshing: ${providerId}`);
  await syncBadgeFromStorage();
  return saved;
}

async function testProvider(providerInput) {
  const configs = await getProviderConfigs();
  const config = typeof providerInput === "string"
    ? configs.find((item) => item.id === providerInput)
    : normalizeProviderConfig(providerInput);
  if (!config) throw new Error(`unknown provider: ${providerInput}`);
  return collectProvider(config, { trigger: "test", tabPolicy: "allow-hidden-tabs" });
}

async function refreshObservedProviders(pageUrl) {
  const configs = configsForObservedUrl(await getProviderConfigs(), pageUrl);
  const now = Date.now();
  const selected = configs.filter((config) => {
    const previous = observedRefreshTimes.get(config.id) || 0;
    if (now - previous < OBSERVED_REFRESH_THROTTLE_MS) return false;
    observedRefreshTimes.set(config.id, now);
    return true;
  });
  if (!selected.length) return [];

  const previous = await getSnapshots();
  const saved = await Promise.all(selected.map(async (config) => {
    const snapshot = await collectOneExclusive(config, previous[config.id], {
      trigger: "page-visit",
      tabPolicy: "reuse-open-tabs"
    });
    return saveCurrentProviderSnapshot(snapshot);
  }));
  await syncBadgeFromStorage();
  return saved.filter(Boolean);
}

function observedPageUrl(message, sender) {
  const senderUrl = sender?.tab?.url;
  if (!senderUrl) return "";
  try {
    const senderParsed = new URL(senderUrl);
    const reported = new URL(message?.url || senderUrl);
    if (!["http:", "https:"].includes(senderParsed.protocol) || senderParsed.origin !== reported.origin) return "";
    return reported.href;
  } catch {
    return "";
  }
}

async function refreshAllProviders(context = {}) {
  const configs = await publicConfigs();
  const previous = await getSnapshots();
  const providers = await runRefreshBatch({
    configs,
    previousSnapshots: previous,
    context,
    collect: collectOneExclusive,
    saveSnapshot: saveCurrentProviderSnapshot
  });
  await syncBadgeFromStorage();
  return providers;
}

async function refreshAllProvidersExclusive(context = {}) {
  const capability = contextCapability(context);
  if (refreshAllFlight) {
    if (refreshAllFlight.capability >= capability) return refreshAllFlight.promise;
    try {
      await refreshAllFlight.promise;
    } catch {
      // Continue with the more capable queued refresh.
    }
    return refreshAllProvidersExclusive(context);
  }
  const refresh = refreshAllProviders(context)
    .finally(() => {
      if (refreshAllFlight?.promise === refresh) refreshAllFlight = null;
    });
  refreshAllFlight = { promise: refresh, capability };
  return refresh;
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

async function runAutoRefresh(contextInput = null) {
  await markAutoRefreshStarted();
  try {
    const context = contextInput || {
      trigger: "auto",
      tabPolicy: (await getExtensionSettings()).autoRefreshTabPolicy
    };
    const providers = await refreshAllProvidersExclusive(context);
    const settings = await markAutoRefreshCompleted();
    return { providers, settings };
  } catch (error) {
    await markAutoRefreshFailed(error);
    throw error;
  }
}

async function bootstrap() {
  await syncVisitObserver(await getProviderConfigs());
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
        return { providers: await refreshAllProvidersExclusive({
          trigger: "manual",
          tabPolicy: "allow-hidden-tabs"
        }) };
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
        await syncVisitObserver(configs);
        await syncBadgeFromStorage();
        return { configs };
      }
      case "config:saveProvider": {
        const provider = await mutateConfigs(() => saveProviderConfig(message.provider));
        await syncVisitObserver(await getProviderConfigs());
        await syncBadgeFromStorage();
        return { provider };
      }
      case "config:importProvider": {
        const provider = await mutateConfigs(() => importProviderConfig(message.provider));
        await syncVisitObserver(await getProviderConfigs());
        await syncBadgeFromStorage();
        return { provider };
      }
      case "config:importProviders": {
        const providers = await mutateConfigs(() => importProviderConfigs(message.providers));
        await syncVisitObserver(await getProviderConfigs());
        await syncBadgeFromStorage();
        return { providers };
      }
      case "config:deleteProvider": {
        const configs = await mutateConfigs(() => deleteProviderConfig(message.providerId));
        await clearProviderSessionHints(message.providerId);
        await syncVisitObserver(configs);
        await syncBadgeFromStorage();
        return { configs };
      }
      case "config:exportProvider":
        return { provider: await exportProviderConfig(message.providerId) };
      case "providers:test":
        return { provider: await testProvider(message.provider || message.providerId) };
      case "provider:pageObserved": {
        const pageUrl = observedPageUrl(message, sender);
        if (!pageUrl) throw new Error("invalid observed provider page");
        return { providers: await refreshObservedProviders(pageUrl) };
      }
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

// A Manifest V3 worker can stop between provider steps. Session-backed progress
// lets a fresh worker continue a recent run without repeating completed sources.
recoverRefreshRun((context) => context.trigger === "auto"
  ? runAutoRefresh(context)
  : refreshAllProvidersExclusive(context)).catch(() => undefined);
