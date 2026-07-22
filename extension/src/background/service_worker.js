import { normalizeProviderConfig } from "../shared/config.js";
import { blankSnapshot, errorSnapshot } from "../shared/snapshots.js";
import {
  getProviderConfigs,
  getSnapshots,
  saveProviderConfigs,
  saveSnapshot,
  setSecret
} from "../shared/storage.js";
import { collectProvider } from "../providers/index.js";

async function publicConfigs() {
  return (await getProviderConfigs()).filter((config) => config.enabled);
}

async function listProviders() {
  const configs = await publicConfigs();
  const snapshots = await getSnapshots();
  return {
    providers: configs.map((config) => snapshots[config.id] || blankSnapshot(config)),
    configs
  };
}

async function refreshProvider(providerId) {
  const configs = await getProviderConfigs();
  const config = configs.find((item) => item.id === providerId);
  if (!config) throw new Error(`unknown provider: ${providerId}`);
  const snapshots = await getSnapshots();
  try {
    return await saveSnapshot(await collectProvider(config));
  } catch (error) {
    return await saveSnapshot(errorSnapshot(config, snapshots[providerId], error));
  }
}

async function refreshAllProviders() {
  const configs = await publicConfigs();
  const providers = [];
  for (const config of configs) {
    providers.push(await refreshProvider(config.id));
  }
  return providers;
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get("providerConfigs");
  if (!Array.isArray(data.providerConfigs)) {
    await saveProviderConfigs((await getProviderConfigs()).map(normalizeProviderConfig));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "providers:list":
        return listProviders();
      case "providers:refresh":
        return { provider: await refreshProvider(message.providerId) };
      case "providers:refreshAll":
        return { providers: await refreshAllProviders() };
      case "config:get":
        return { configs: await getProviderConfigs() };
      case "config:save":
        return { configs: await saveProviderConfigs(message.configs || []) };
      case "secret:setDeepSeekKey":
        if (message.value) {
          await setSecret("deepseekApiKey", message.value);
        }
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
