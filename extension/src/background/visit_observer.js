import { originsForConfig } from "../shared/config.js";

export const VISIT_CONTENT_SCRIPT_ID = "provider-usage-visit-observer";

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function configsForObservedUrl(configs, pageUrl) {
  return (configs || []).filter((config) => {
    if (!config?.enabled || config.refreshOnVisit !== true) return false;
    const urls = [config.targetUrl, ...(config.secondaryUrls || []).map((page) => page.url)];
    return urls.some((url) => sameOrigin(url, pageUrl));
  });
}

async function grantedOrigins(configs) {
  const origins = [...new Set(configs.flatMap(originsForConfig))];
  if (!globalThis.chrome?.permissions?.contains) return origins;
  const checks = await Promise.all(origins.map(async (origin) => {
    try {
      return await chrome.permissions.contains({ origins: [origin] }) ? origin : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

export async function syncVisitObserver(configs) {
  if (!globalThis.chrome?.scripting?.registerContentScripts) return { registered: false, matches: [] };
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [VISIT_CONTENT_SCRIPT_ID] });
  } catch {
    // The script may not have been registered yet.
  }

  const observed = (configs || []).filter((config) => config.enabled && config.refreshOnVisit === true);
  const matches = await grantedOrigins(observed);
  if (!matches.length) return { registered: false, matches: [] };
  await chrome.scripting.registerContentScripts([{
    id: VISIT_CONTENT_SCRIPT_ID,
    js: ["src/content/provider_observer.js"],
    matches,
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);
  return { registered: true, matches };
}
