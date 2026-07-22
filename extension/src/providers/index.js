import { DEEPSEEK_BALANCE_URL } from "../shared/config.js";
import {
  NotLoggedInError,
  OPENCODE_LOGIN_HINTS,
  EZAICLUB_LOGIN_HINTS,
  SILICONFLOW_LOGIN_HINTS,
  deepseekHttpErrorMessage,
  deriveOpencodeBillingUrl,
  ezaiclubSnapshot,
  extractJsonPayloads,
  htmlTokens,
  isLoginHtml,
  opencodeSnapshot,
  pageTextTokens,
  parseDeepseekBalance,
  parseEzaiclubBalanceTokens,
  parseEzaiclubSubscriptionTokens,
  parseOpencodeBalanceTokens,
  parseOpencodeLegacy,
  parseSiliconflowBalanceTokens,
  parseSiliconflowMetricTokens,
  siliconflowSnapshot
} from "../shared/parsers.js";
import { blankSnapshot } from "../shared/snapshots.js";
import { getSecret } from "../shared/storage.js";

async function fetchText(url) {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url}`);
  }
  return { url: response.url || url, text, ok: response.ok, status: response.status };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(deepseekHttpErrorMessage(response.status));
  }
  return response.json();
}

const RENDER_WAIT_MS = 18000;
const DEFAULT_RENDER_WAIT_OPTIONS = {
  waitMs: RENDER_WAIT_MS,
  minWaitMs: 1500,
  stableSamples: 5,
  readyPattern: "余额|可用|剩余|赠金|充值|券|优惠券|代金券|账单|费用|消费|有效|到期|balance|coupon|credit|amount|expense|bill|valid|expires"
};
const EZAICLUB_BALANCE_WAIT_OPTIONS = {
  waitMs: 18000,
  minWaitMs: 2500,
  stableSamples: 6,
  readyPattern: "账户余额|可用余额|余额|充值|balance|wallet|credit|[$¥￥]\\s*\\d|\\d+(?:\\.\\d+)?\\s*(?:USD|CNY|RMB|元)"
};
const EZAICLUB_SUBSCRIPTION_WAIT_OPTIONS = {
  waitMs: 24000,
  minWaitMs: 5000,
  stableSamples: 8,
  readyPattern: "当前套餐|套餐名称|订阅状态|订阅用量|到期时间|有效期|续费时间|已达到|Pro|Monthly|Plan|Subscription|Subscriptions|expires|expiresAt|expires_at|planName|plan_name|renew|endDate"
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractTokensFromTab(tabId, waitOptions = {}) {
  const effectiveWaitOptions = { ...DEFAULT_RENDER_WAIT_OPTIONS, ...waitOptions };
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (options) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const usagePattern = new RegExp(options.readyPattern, "i");
      const startedAt = Date.now();
      const deadline = startedAt + options.waitMs;
      let lastText = "";
      let stableCount = 0;

      while (Date.now() < deadline) {
        const text = document.body ? document.body.innerText : "";
        const waitedLongEnough = Date.now() - startedAt >= options.minWaitMs;
        if (waitedLongEnough && usagePattern.test(text)) {
          break;
        }
        if (text && text === lastText) {
          stableCount += 1;
          if (waitedLongEnough && stableCount >= options.stableSamples) {
            break;
          }
        } else {
          stableCount = 0;
        }
        lastText = text;
        await sleep(500);
      }

      const storageValues = [];
      for (const storage of [window.localStorage, window.sessionStorage]) {
        try {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            const value = storage.getItem(key);
            if (value && value.length <= 50000) {
              storageValues.push(key, value);
            }
          }
        } catch {
          // Ignore storage access failures from the page.
        }
      }

      return {
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText : "",
        jsonScripts: Array.from(document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__'))
          .map((node) => node.textContent || ""),
        storageValues
      };
    },
    args: [effectiveWaitOptions]
  });
  if (!result) return null;
  const tokens = pageTextTokens(result.text);
  for (const item of [...(result.jsonScripts || []), ...(result.storageValues || [])]) {
    try {
      tokens.push(...extractJsonPayloads([{ data: JSON.parse(item) }]));
    } catch {
      tokens.push(...pageTextTokens(item));
    }
  }
  return { ...result, tokens };
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getOpenTabTokens(url, options = {}) {
  if (!chrome.tabs || !chrome.scripting) return null;
  const tabs = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
  const matchingTab = pickBestTab(tabs, url, options);
  if (!matchingTab?.id) return null;
  return extractTokensFromTab(matchingTab.id, options.waitOptions);
}

async function getRenderedTabTokens(url, options = {}) {
  if (!chrome.tabs || !chrome.scripting) return null;
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) return null;
  try {
    await waitForTabComplete(tab.id);
    await delay(options.afterLoadDelayMs ?? 1500);
    return await extractTokensFromTab(tab.id, options.waitOptions);
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // The user or browser may already have closed the tab.
    }
  }
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function pickBestTab(tabs, targetUrl, options = {}) {
  const target = new URL(targetUrl);
  const matches = [...tabs]
    .filter((tab) => tab.url && sameOrigin(tab.url, targetUrl))
    .filter((tab) => !options.requirePathMatch || new URL(tab.url).pathname === target.pathname)
    .sort((left, right) => tabMatchScore(right.url, target) - tabMatchScore(left.url, target))[0] || null;
  return matches;
}

function tabMatchScore(tabUrl, target) {
  try {
    const current = new URL(tabUrl);
    let score = 1;
    if (current.href === target.href) score += 3;
    if (current.pathname === target.pathname) score += 2;
    if (current.pathname === target.pathname && current.search === target.search) score += 1;
    return score;
  } catch {
    return 0;
  }
}

async function tokensFromUrl(url, loginHints, loginError, options = {}) {
  const openTab = await getOpenTabTokens(url, options);
  if (openTab?.tokens?.length) {
    if (isLoginHtml(openTab.url, `${openTab.title}\n${openTab.text}`, loginHints)) {
      throw new NotLoggedInError(loginError);
    }
    if (options.renderFallback && options.shouldUseRenderedTokens?.(openTab.tokens)) {
      const rendered = await getRenderedTabTokens(url, options);
      if (rendered?.tokens?.length) {
        if (isLoginHtml(rendered.url, `${rendered.title}\n${rendered.text}`, loginHints)) {
          throw new NotLoggedInError(loginError);
        }
        return { url: rendered.url, tokens: rendered.tokens };
      }
    }
    return { url: openTab.url, tokens: openTab.tokens };
  }
  const page = await fetchText(url);
  if (isLoginHtml(page.url, page.text, loginHints)) {
    throw new NotLoggedInError(loginError);
  }
  const fetchedTokens = htmlTokens(page.text);
  if (options.renderFallback && options.shouldUseRenderedTokens?.(fetchedTokens)) {
    const rendered = await getRenderedTabTokens(url, options);
    if (rendered?.tokens?.length) {
      if (isLoginHtml(rendered.url, `${rendered.title}\n${rendered.text}`, loginHints)) {
        throw new NotLoggedInError(loginError);
      }
      return { url: rendered.url, tokens: rendered.tokens };
    }
  }
  return { url: page.url, tokens: fetchedTokens };
}

async function collectOpenCode(config) {
  const main = await tokensFromUrl(
    config.targetUrl,
    OPENCODE_LOGIN_HINTS,
    "Current browser is not logged in to opencode.ai"
  );
  const legacy = parseOpencodeLegacy(main.tokens, main.url);
  try {
    const billing = await fetchText(deriveOpencodeBillingUrl(config.targetUrl));
    if (!isLoginHtml(billing.url, billing.text, OPENCODE_LOGIN_HINTS)) {
      legacy.balances = parseOpencodeBalanceTokens(htmlTokens(billing.text));
    } else {
      legacy.balances = [];
    }
  } catch {
    legacy.balances = [];
  }
  return opencodeSnapshot(config, legacy);
}

async function collectDeepSeek(config) {
  const apiKey = await getSecret("deepseekApiKey");
  if (!apiKey) {
    return blankSnapshot(config, "unconfigured", "Set DeepSeek API Key in extension options");
  }
  const data = await fetchJson(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  return parseDeepseekBalance(data, config);
}

async function collectEzaiclub(config) {
  const dashboard = await tokensFromUrl(
    config.targetUrl,
    EZAICLUB_LOGIN_HINTS,
    "Current browser is not logged in to EZAICLUB",
    {
      renderFallback: true,
      requirePathMatch: true,
      waitOptions: EZAICLUB_BALANCE_WAIT_OPTIONS,
      afterLoadDelayMs: 2000,
      shouldUseRenderedTokens: (tokens) => {
        return !parseEzaiclubBalanceTokens(tokens).length;
      }
    }
  );
  const balances = parseEzaiclubBalanceTokens(dashboard.tokens);
  const subscriptionUrl =
    (config.secondaryUrls || []).find(
      (item) => item.url.includes("/subscriptions") || item.url.includes("subscription")
    )?.url || "https://www.ezaiclub.com/subscriptions";
  let subscriptionMetrics = [];
  try {
    const subscription = await tokensFromUrl(
      subscriptionUrl,
      EZAICLUB_LOGIN_HINTS,
      "Current browser is not logged in to EZAICLUB",
      {
        renderFallback: true,
        requirePathMatch: true,
        waitOptions: EZAICLUB_SUBSCRIPTION_WAIT_OPTIONS,
        afterLoadDelayMs: 2500,
        shouldUseRenderedTokens: (tokens) => {
          return !parseEzaiclubSubscriptionTokens(tokens).length;
        }
      }
    );
    subscriptionMetrics = parseEzaiclubSubscriptionTokens(subscription.tokens);
  } catch (error) {
    if (error instanceof NotLoggedInError) throw error;
  }
  return ezaiclubSnapshot(config, dashboard.url, balances, subscriptionMetrics);
}

async function collectSiliconFlow(config) {
  const page = await tokensFromUrl(
    config.targetUrl,
    SILICONFLOW_LOGIN_HINTS,
    "Current browser is not logged in to SiliconFlow",
    {
      renderFallback: true,
      shouldUseRenderedTokens: (tokens) => {
        return !parseSiliconflowBalanceTokens(tokens).length && !parseSiliconflowMetricTokens(tokens).length;
      }
    }
  );
  const balances = parseSiliconflowBalanceTokens(page.tokens);
  const metrics = parseSiliconflowMetricTokens(page.tokens);
  return siliconflowSnapshot(config, page.url, balances, metrics);
}

export async function collectProvider(config) {
  if (config.type === "opencode") return collectOpenCode(config);
  if (config.type === "deepseek") return collectDeepSeek(config);
  if (config.type === "ezaiclub") return collectEzaiclub(config);
  if (config.type === "siliconflow") return collectSiliconFlow(config);
  throw new Error(`unsupported provider type: ${config.type}`);
}
