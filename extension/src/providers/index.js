import { DEEPSEEK_BALANCE_URL, originsForConfig } from "../shared/config.js";
import {
  NotLoggedInError,
  OPENCODE_LOGIN_HINTS,
  EZAICLUB_LOGIN_HINTS,
  NEWAPI_LOGIN_HINTS,
  SUB2API_LOGIN_HINTS,
  SILICONFLOW_LOGIN_HINTS,
  deepseekHttpErrorMessage,
  deriveOpencodeBillingUrl,
  ezaiclubApiSnapshot,
  ezaiclubSnapshot,
  extractJsonPayloads,
  genericPageSnapshot,
  htmlTokens,
  isLoginHtml,
  opencodeSnapshot,
  pageTextTokens,
  parseGenericPageTokens,
  parseGenericSelectorResults,
  parseDeepseekBalance,
  parseEzaiclubBalanceTokens,
  parseEzaiclubSubscriptionTokens,
  isNewApiSelfPayload,
  isSub2ApiAuthPayload,
  newApiSnapshot,
  parseOpencodeBalanceTokens,
  parseOpencodeLegacy,
  parseSiliconflowBalanceTokens,
  parseSiliconflowMetricTokens,
  parseSub2ApiDashboardTokens,
  siliconflowApiSnapshot,
  siliconflowSnapshot,
  sub2ApiPageSnapshot,
  sub2ApiSnapshot
} from "../shared/parsers.js";
import { blankSnapshot } from "../shared/snapshots.js";
import { getSecret } from "../shared/storage.js";
import {
  attachCollectionDiagnostics,
  createCollectionContext,
  decorateCollectionError,
  NeedsVisitError,
  TAB_POLICIES
} from "./runtime.js";
import { deleteSessionHint, getSessionHint, setSessionHint } from "./session_cache.js";
import { createProviderRegistry } from "./registry.js";

const EZAICLUB_AUTH_TOKEN_KEY = "auth_token";
const EZAICLUB_SESSION_HINT = "authToken";
const EZAICLUB_SESSION_TTL_MS = 20 * 60 * 1000;
const EZAICLUB_API_TIMEZONE = "Asia/Shanghai";
const SUB2API_AUTH_TOKEN_KEY = "auth_token";
const SUB2API_SESSION_HINT = "authToken";
const SUB2API_SESSION_TTL_MS = 20 * 60 * 1000;
const SUB2API_API_TIMEZONE = "Asia/Shanghai";
const SILICONFLOW_SUBJECT_PROBE = "sf-subject-id";
const SILICONFLOW_SESSION_HINT = "subjectId";
const SILICONFLOW_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 15000;
const MAX_PAGE_TEXT_LENGTH = 250000;
const MAX_JSON_SCRIPTS = 10;
const MAX_JSON_SCRIPT_LENGTH = 100000;
const MAX_SELECTOR_VALUES = 100;
const MAX_SELECTOR_VALUE_LENGTH = 10000;

export async function requestWithTimeout(url, options, readResponse, timeoutMs = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await readResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms while loading ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  return requestWithTimeout(url, {
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  }, async (response) => {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while loading ${url}`);
    }
    return { url: response.url || url, text, ok: response.ok, status: response.status };
  });
}

async function fetchJson(url, options = {}) {
  return requestWithTimeout(url, {
    credentials: "include",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  }, async (response) => {
    if (!response.ok) {
      throw new Error(deepseekHttpErrorMessage(response.status));
    }
    return response.json();
  });
}

async function fetchNewApiJson(url, options = {}) {
  return requestWithTimeout(url, {
    credentials: "include",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  }, async (response) => {
    const contentType = response.headers?.get?.("content-type") || "";
    if (response.status === 401 || response.status === 403) {
      throw new NotLoggedInError("Current browser is not logged in to New API");
    }
    if (response.status === 404 || (contentType && !contentType.includes("json"))) return null;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (!response.ok) {
      const message = payload?.message || `New API returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  });
}

async function fetchSub2ApiJson(url, token, providerName = "Sub2API") {
  return requestWithTimeout(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  }, async (response) => {
    const contentType = response.headers?.get?.("content-type") || "";
    let payload = null;
    try {
      payload = contentType.includes("json") ? await response.json() : null;
    } catch {
      payload = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new NotLoggedInError(`Current browser is not logged in to ${providerName}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(payload?.message || `${providerName} API returned HTTP ${response.status}`);
    }
    return payload;
  });
}

const RENDER_WAIT_MS = 12000;
const DEFAULT_RENDER_WAIT_OPTIONS = {
  waitMs: RENDER_WAIT_MS,
  minWaitMs: 600,
  pollMs: 250,
  stableSamples: 3,
  readyPattern: "余额|可用|剩余|赠金|充值|券|优惠券|代金券|账单|费用|消费|有效|到期|balance|coupon|credit|amount|expense|bill|valid|expires"
};
const EZAICLUB_BALANCE_WAIT_OPTIONS = {
  waitMs: 12000,
  minWaitMs: 800,
  pollMs: 250,
  stableSamples: 3,
  readyPattern: "账户余额|可用余额|余额|充值|balance|wallet|credit|[$¥￥]\\s*\\d|\\d+(?:\\.\\d+)?\\s*(?:USD|CNY|RMB|元)"
};
const EZAICLUB_SUBSCRIPTION_WAIT_OPTIONS = {
  waitMs: 16000,
  minWaitMs: 1500,
  pollMs: 250,
  stableSamples: 4,
  readyPattern: "当前套餐|套餐名称|订阅状态|订阅用量|到期时间|有效期|续费时间|已达到|Pro|Monthly|Plan|Subscription|Subscriptions|expires|expiresAt|expires_at|planName|plan_name|renew|endDate"
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyCollectionContext(context, hook, ...args) {
  try {
    await context?.[hook]?.(...args);
  } catch {
    // Refresh progress bookkeeping must not break provider collection.
  }
}

function scopedSessionHint(name, url) {
  return `${name}:${new URL(url).origin}`;
}

/** Reuse one background tab across multiple navigations (same provider multi-page). */
export function createTabSession(contextInput = {}) {
  const defaultContext = createCollectionContext(contextInput);
  let tabId = null;
  let tabContext = defaultContext;
  return {
    async load(url, options = {}) {
      if (!chrome.tabs || !chrome.scripting) return null;
      const context = options.collectionContext || defaultContext;
      if (tabId == null) {
        if (context.tabPolicy !== TAB_POLICIES.ALLOW_HIDDEN_TABS) {
          throw new NeedsVisitError(`Open ${new URL(url).origin} to refresh this provider`);
        }
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id ?? null;
        tabContext = context;
        if (tabId != null) await notifyCollectionContext(context, "onTabCreated", tabId, url);
      } else if (chrome.tabs.update) {
        await chrome.tabs.update(tabId, { url });
      } else {
        const previousTabId = tabId;
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // ignore
        }
        await notifyCollectionContext(context, "onTabClosed", previousTabId);
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id ?? null;
        tabContext = context;
        if (tabId != null) await notifyCollectionContext(context, "onTabCreated", tabId, url);
      }
      if (tabId == null) return null;
      await waitForTabComplete(tabId);
      const delayMs = Number(options.afterLoadDelayMs ?? 0);
      if (delayMs > 0) await delay(delayMs);
      return extractTokensFromTab(tabId, options.waitOptions, options.selectorRules || []);
    },
    async close() {
      if (tabId == null) return;
      const closingTabId = tabId;
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The user or browser may already have closed the tab.
      }
      tabId = null;
      await notifyCollectionContext(tabContext, "onTabClosed", closingTabId);
    }
  };
}

export async function extractTokensFromTab(tabId, waitOptions = {}, selectorRules = []) {
  const selectorOnly = selectorRules.length > 0;
  const effectiveWaitOptions = {
    ...DEFAULT_RENDER_WAIT_OPTIONS,
    ...waitOptions,
    selectorRules,
    selectorOnly,
    maxPageTextLength: MAX_PAGE_TEXT_LENGTH,
    maxJsonScripts: MAX_JSON_SCRIPTS,
    maxJsonScriptLength: MAX_JSON_SCRIPT_LENGTH,
    maxSelectorValues: MAX_SELECTOR_VALUES,
    maxSelectorValueLength: MAX_SELECTOR_VALUE_LENGTH
  };
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (options) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const usagePattern = options.readyPattern ? new RegExp(options.readyPattern, "i") : null;
      const startedAt = Date.now();
      const deadline = startedAt + options.waitMs;
      let lastText = "";
      let stableCount = 0;

      const truncate = (value, maxLength) => String(value || "").slice(0, maxLength);
      const pageText = () => truncate(document.body?.innerText || "", options.maxPageTextLength);

      const readNodeValue = (node, attribute = "textContent") => {
        let value = "";
        if (attribute === "textContent") value = node.textContent || "";
        else if (attribute === "innerText") value = node.innerText || "";
        else if (attribute === "value" && "value" in node) value = node.value || "";
        else value = node.getAttribute(attribute) || "";
        return truncate(value, options.maxSelectorValueLength);
      };
      const selectNodes = (selector) => {
        if (!selector) return [];
        try {
          return document.querySelectorAll(selector);
        } catch (error) {
          throw new Error(`Invalid CSS selector ${selector}: ${error.message}`);
        }
      };
      const selectorHasValue = (selector, attribute = "textContent", index = 0) => {
        const nodes = selectNodes(selector);
        const node = nodes[Math.max(0, Number(index) || 0)];
        return Boolean(node && String(readNodeValue(node, attribute)).trim());
      };
      const ruleReady = (rule) => {
        if (rule.mode === "separate" || rule.usedSelector || rule.limitSelector) {
          return selectorHasValue(rule.usedSelector, rule.usedAttribute || rule.attribute, rule.usedIndex ?? rule.index)
            && selectorHasValue(rule.limitSelector, rule.limitAttribute || rule.attribute, rule.limitIndex ?? rule.index);
        }
        return selectorHasValue(rule.selector, rule.attribute, rule.index);
      };

      const pollMs = Math.max(100, Number(options.pollMs) || 250);
      while (Date.now() < deadline) {
        const text = options.selectorOnly ? "" : pageText();
        const waitedLongEnough = Date.now() - startedAt >= options.minWaitMs;
        let selectorReady = false;
        if (options.readySelector || options.selectorRules.length) {
          selectorReady = options.readySelector
            ? selectNodes(options.readySelector).length > 0
            : options.selectorRules.every(ruleReady);
        }
        // Selector/ready pattern can finish as soon as content is present.
        if (selectorReady || (waitedLongEnough && usagePattern?.test(text))) {
          break;
        }
        if (!options.selectorRules.length && !options.readySelector && text && text === lastText) {
          stableCount += 1;
          if (waitedLongEnough && stableCount >= options.stableSamples) {
            break;
          }
        } else {
          stableCount = 0;
        }
        lastText = text;
        await sleep(pollMs);
      }

      const readValues = (selector, attribute = "textContent", index = null) => {
        const nodes = selectNodes(selector);
        const matchCount = nodes.length;
        if (index != null && index !== "") {
          const node = nodes[Math.max(0, Number(index) || 0)];
          const selected = node ? String(readNodeValue(node, attribute)).trim() : "";
          return { values: selected ? [selected] : [], matchCount, samples: selected ? [selected] : [] };
        }
        const values = [];
        for (let nodeIndex = 0; nodeIndex < Math.min(nodes.length, options.maxSelectorValues); nodeIndex += 1) {
          const value = String(readNodeValue(nodes[nodeIndex], attribute)).trim();
          if (value) values.push(value);
        }
        return { values, matchCount, samples: values.slice(0, 3) };
      };
      const selectorResults = {};
      for (const rule of options.selectorRules) {
        const valueResult = readValues(rule.selector, rule.attribute, rule.index);
        const usedResult = readValues(rule.usedSelector, rule.usedAttribute || rule.attribute, rule.usedIndex ?? rule.index);
        const limitResult = readValues(rule.limitSelector, rule.limitAttribute || rule.attribute, rule.limitIndex ?? rule.index);
        const resetResult = readValues(rule.resetSelector, rule.resetAttribute || "textContent", rule.resetIndex);
        selectorResults[rule.id] = {
          values: valueResult.values,
          usedValues: usedResult.values,
          limitValues: limitResult.values,
          resetValues: resetResult.values,
          matchCount: valueResult.matchCount,
          usedMatchCount: usedResult.matchCount,
          limitMatchCount: limitResult.matchCount,
          resetMatchCount: resetResult.matchCount,
          samples: valueResult.samples,
          usedSamples: usedResult.samples,
          limitSamples: limitResult.samples,
          resetSamples: resetResult.samples
        };
      }

      const finalPageText = options.selectorOnly ? "" : pageText();
      const loginText = options.selectorOnly
        ? `${location.href}\n${document.title}`
        : `${location.href}\n${document.title}\n${finalPageText}`;
      return {
        title: document.title,
        url: location.href,
        text: finalPageText,
        loginDetected: (options.loginHints || []).some((hint) => loginText.includes(hint)),
        jsonScripts: options.selectorOnly ? [] : Array.from(document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__'))
          .slice(0, options.maxJsonScripts)
          .map((node) => truncate(node.textContent || "", options.maxJsonScriptLength))
          .filter(Boolean),
        selectorResults
      };
    },
    args: [{ ...effectiveWaitOptions, loginHints: waitOptions.loginHints || [] }]
  });
  if (!result) return null;
  const tokens = pageTextTokens(result.text);
  for (const item of result.jsonScripts || []) {
    try {
      tokens.push(...extractJsonPayloads([{ data: JSON.parse(item) }]));
    } catch {
      tokens.push(...pageTextTokens(item));
    }
  }
  return { ...result, tokens };
}

export async function waitForTabComplete(tabId, timeoutMs = 20000) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => done(new Error(`Timed out after ${timeoutMs}ms while loading browser tab`)), timeoutMs);
    function done(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved?.removeListener?.(removedListener);
      if (error) reject(error);
      else resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        done();
      }
    }
    function removedListener(removedTabId) {
      if (removedTabId === tabId) done(new Error("Browser tab was closed while loading"));
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved?.addListener?.(removedListener);
    // Register listeners before checking the current state. Otherwise a tab can
    // finish between tabs.get() and addListener(), leaving this promise waiting
    // until its timeout even though the page is already complete.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab?.status === "complete") done();
      },
      (error) => done(error)
    );
  });
}

async function getOpenTabTokens(url, options = {}) {
  if (!chrome.tabs || !chrome.scripting) return null;
  if (options.collectionContext?.tabPolicy === TAB_POLICIES.API_ONLY) return null;
  const tabs = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
  const matchingTab = pickBestTab(tabs, url, options);
  if (!matchingTab?.id) return null;
  return extractTokensFromTab(matchingTab.id, options.waitOptions, options.selectorRules || []);
}

async function getRenderedTabTokens(url, options = {}) {
  if (!chrome.tabs || !chrome.scripting) return null;
  if (options.tabSession) {
    return options.tabSession.load(url, options);
  }
  const context = options.collectionContext || createCollectionContext();
  if (context.tabPolicy !== TAB_POLICIES.ALLOW_HIDDEN_TABS) {
    throw new NeedsVisitError(`Open ${new URL(url).origin} to refresh this provider`);
  }
  const session = createTabSession(context);
  try {
    return await session.load(url, options);
  } finally {
    await session.close();
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
  const isLoginPage = (page) => page?.loginDetected === true
    || isLoginHtml(page?.url, `${page?.title || ""}\n${page?.text || ""}`, loginHints);
  const openTab = await getOpenTabTokens(url, options);
  if (openTab?.tokens?.length || Object.keys(openTab?.selectorResults || {}).length) {
    if (isLoginPage(openTab)) {
      throw new NotLoggedInError(loginError);
    }
    if (options.renderFallback && options.shouldUseRenderedTokens?.(openTab.tokens, openTab)) {
      const rendered = await getRenderedTabTokens(url, options);
      if (rendered?.tokens?.length || Object.keys(rendered?.selectorResults || {}).length) {
        if (isLoginPage(rendered)) {
          throw new NotLoggedInError(loginError);
        }
        return rendered;
      }
    }
    return openTab;
  }
  if (options.selectorRules?.length) {
    const rendered = await getRenderedTabTokens(url, options);
    if (rendered && (rendered.tokens?.length || Object.keys(rendered.selectorResults || {}).length)) {
      if (isLoginPage(rendered)) throw new NotLoggedInError(loginError);
      return rendered;
    }
  }
  const page = await fetchText(url);
  if (isLoginHtml(page.url, page.text, loginHints)) {
    throw new NotLoggedInError(loginError);
  }
  const fetchedTokens = htmlTokens(page.text);
  if (options.renderFallback && options.shouldUseRenderedTokens?.(fetchedTokens, null)) {
    const rendered = await getRenderedTabTokens(url, options);
    if (rendered?.tokens?.length || Object.keys(rendered?.selectorResults || {}).length) {
      if (isLoginPage(rendered)) {
        throw new NotLoggedInError(loginError);
      }
      return rendered;
    }
  }
  return { url: page.url, tokens: fetchedTokens };
}

async function collectOpenCode(config, context) {
  const main = await tokensFromUrl(
    config.targetUrl,
    OPENCODE_LOGIN_HINTS,
    "Current browser is not logged in to opencode.ai",
    { collectionContext: context }
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

async function readTabLocalStorageKey(tabId, key) {
  if (!chrome.scripting?.executeScript || tabId == null) return "";
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (storageKey) => {
        try {
          return window.localStorage.getItem(storageKey) || "";
        } catch {
          return "";
        }
      },
      args: [key]
    });
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

async function getLocalStorageSessionValue(config, context, { storageKey, sessionHint, ttlMs }) {
  const hintName = scopedSessionHint(sessionHint, config.targetUrl);
  const cached = await getSessionHint(config.id, hintName);
  if (cached) return cached;
  const browser = globalThis.chrome;
  if (!browser?.scripting?.executeScript) return "";
  const origin = new URL(config.targetUrl).origin;
  const target = new URL(config.targetUrl);

  if (browser.tabs?.query && context.tabPolicy !== TAB_POLICIES.API_ONLY) {
    const tabs = await browser.tabs.query({ url: `${origin}/*` });
    const ranked = [...tabs]
      .filter((tab) => tab.id != null && tab.url)
      .sort((left, right) => tabMatchScore(right.url, target) - tabMatchScore(left.url, target));
    for (const tab of ranked) {
      const value = await readTabLocalStorageKey(tab.id, storageKey);
      if (value) {
        await setSessionHint(config.id, hintName, value, ttlMs);
        return value;
      }
    }
  }

  if (!browser.tabs?.create || context.tabPolicy !== TAB_POLICIES.ALLOW_HIDDEN_TABS) return "";
  let tabId = null;
  try {
    const tab = await browser.tabs.create({ url: config.targetUrl, active: false });
    tabId = tab.id ?? null;
    if (tabId == null) return "";
    await notifyCollectionContext(context, "onTabCreated", tabId, config.targetUrl);
    await waitForTabComplete(tabId, 15000);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = await readTabLocalStorageKey(tabId, storageKey);
      if (value) {
        await setSessionHint(config.id, hintName, value, ttlMs);
        return value;
      }
      await delay(300);
    }
    return "";
  } catch {
    return "";
  } finally {
    if (tabId != null) {
      const closingTabId = tabId;
      try {
        await browser.tabs.remove(tabId);
      } catch {
        // Tab may already be closed.
      }
      await notifyCollectionContext(context, "onTabClosed", closingTabId);
    }
  }
}

async function getEzaiclubAuthToken(config, context) {
  return getLocalStorageSessionValue(config, context, {
    storageKey: EZAICLUB_AUTH_TOKEN_KEY,
    sessionHint: EZAICLUB_SESSION_HINT,
    ttlMs: EZAICLUB_SESSION_TTL_MS
  });
}

async function fetchEzaiclubJson(url, token) {
  return requestWithTimeout(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  }, async (response) => {
    if (response.status === 401 || response.status === 403) {
      throw new NotLoggedInError("Current browser is not logged in to EZAICLUB");
    }
    if (!response.ok) {
      throw new Error(`EZAICLUB API returned HTTP ${response.status}`);
    }
    return response.json();
  });
}

async function collectEzaiclubViaApi(config, context) {
  const token = await getEzaiclubAuthToken(config, context);
  if (!token) return null;
  try {
    const origin = new URL(config.targetUrl).origin;
    const timezone = encodeURIComponent(EZAICLUB_API_TIMEZONE);
    const me = await fetchEzaiclubJson(`${origin}/api/v1/auth/me?timezone=${timezone}`, token);
    if (me?.code != null && Number(me.code) !== 0) {
      throw new Error(me.message || `EZAICLUB auth/me failed with code ${me.code}`);
    }
    let subscriptions = { code: 0, data: [] };
    try {
      subscriptions = await fetchEzaiclubJson(
        `${origin}/api/v1/subscriptions/active?timezone=${timezone}`,
        token
      );
    } catch (error) {
      if (error instanceof NotLoggedInError) throw error;
    }
    const snapshot = ezaiclubApiSnapshot(config, me, subscriptions);
    if (!snapshot.balances.length && !snapshot.metrics.length) return null;
    return snapshot;
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      await deleteSessionHint(config.id, scopedSessionHint(EZAICLUB_SESSION_HINT, config.targetUrl));
    }
    throw error;
  }
}

async function collectEzaiclubViaPage(config, context) {
  const tabSession = createTabSession(context);
  try {
    const dashboard = await tokensFromUrl(
      config.targetUrl,
      EZAICLUB_LOGIN_HINTS,
      "Current browser is not logged in to EZAICLUB",
      {
        renderFallback: true,
        requirePathMatch: true,
        waitOptions: EZAICLUB_BALANCE_WAIT_OPTIONS,
        afterLoadDelayMs: 0,
        collectionContext: context,
        tabSession,
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
          afterLoadDelayMs: 0,
          collectionContext: context,
          tabSession,
          shouldUseRenderedTokens: (tokens) => {
            return !parseEzaiclubSubscriptionTokens(tokens).length;
          }
        }
      );
      subscriptionMetrics = parseEzaiclubSubscriptionTokens(subscription.tokens);
    } catch (error) {
      if (error instanceof NotLoggedInError) throw error;
    }
    return ezaiclubSnapshot(config, dashboard.url, balances, subscriptionMetrics, { source: "page" });
  } finally {
    await tabSession.close();
  }
}

async function collectEzaiclub(config, context) {
  try {
    const apiSnapshot = await context.runAttempt(
      "ezaiclub-api",
      "network",
      () => collectEzaiclubViaApi(config, context)
    );
    if (apiSnapshot) return apiSnapshot;
  } catch {
    // The attempt is recorded on the collection context before falling back.
  }
  return context.runAttempt(
    "ezaiclub-page",
    "page",
    () => collectEzaiclubViaPage(config, context)
  );
}

async function readTabSiliconflowSubjectId(tabId) {
  if (!chrome.scripting?.executeScript || tabId == null) return "";
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      // SF_SUBJECT_ID is created by the page application. The default isolated
      // world cannot observe page-owned JavaScript globals.
      world: "MAIN",
      // args tag lets tests distinguish this probe from DOM extraction.
      func: (_probe) => {
        try {
          const id = globalThis.SF_SUBJECT_ID || globalThis.subjectInfo?.subjectId || "";
          return id == null ? "" : String(id);
        } catch {
          return "";
        }
      },
      args: [SILICONFLOW_SUBJECT_PROBE]
    });
    return typeof result === "string" ? result.trim() : "";
  } catch {
    return "";
  }
}

async function getSiliconflowSubjectId(config, context) {
  const hintName = scopedSessionHint(SILICONFLOW_SESSION_HINT, config.targetUrl);
  const cached = await getSessionHint(config.id, hintName);
  if (cached) return cached;
  if (!chrome.scripting?.executeScript) return "";
  const origin = new URL(config.targetUrl).origin;
  const target = new URL(config.targetUrl);

  if (chrome.tabs?.query && context.tabPolicy !== TAB_POLICIES.API_ONLY) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const ranked = [...tabs]
      .filter((tab) => tab.id != null && tab.url)
      .sort((left, right) => tabMatchScore(right.url, target) - tabMatchScore(left.url, target));
    for (const tab of ranked) {
      const subjectId = await readTabSiliconflowSubjectId(tab.id);
      if (subjectId) {
        await setSessionHint(config.id, hintName, subjectId, SILICONFLOW_SESSION_TTL_MS);
        return subjectId;
      }
    }
  }

  if (!chrome.tabs?.create || context.tabPolicy !== TAB_POLICIES.ALLOW_HIDDEN_TABS) return "";
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: config.targetUrl, active: false });
    tabId = tab.id ?? null;
    if (tabId == null) return "";
    await notifyCollectionContext(context, "onTabCreated", tabId, config.targetUrl);
    await waitForTabComplete(tabId, 15000);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const subjectId = await readTabSiliconflowSubjectId(tabId);
      if (subjectId) {
        await setSessionHint(config.id, hintName, subjectId, SILICONFLOW_SESSION_TTL_MS);
        return subjectId;
      }
      await delay(300);
    }
    return "";
  } catch {
    return "";
  } finally {
    if (tabId != null) {
      const closingTabId = tabId;
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // ignore
      }
      await notifyCollectionContext(context, "onTabClosed", closingTabId);
    }
  }
}

async function fetchSiliconflowJson(url, subjectId) {
  return requestWithTimeout(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "x-subject-id": subjectId
    }
  }, async (response) => {
    if (response.status === 401 || response.status === 403) {
      throw new NotLoggedInError("Current browser is not logged in to SiliconFlow");
    }
    if (!response.ok) {
      throw new Error(`SiliconFlow API returned HTTP ${response.status}`);
    }
    return response.json();
  });
}

function siliconflowApiOk(payload) {
  if (payload == null) return false;
  if (payload.code == null) return true;
  const code = Number(payload.code);
  return code === 0 || code === 200 || code === 20000;
}

async function collectSiliconflowViaApi(config, context) {
  const subjectId = await getSiliconflowSubjectId(config, context);
  if (!subjectId) return null;
  const origin = "https://cloud.siliconflow.cn";
  let authenticationError = null;
  const fetchOptional = (url) => fetchSiliconflowJson(url, subjectId).catch((error) => {
    if (error instanceof NotLoggedInError) authenticationError = error;
    return null;
  });
  const [profile, balanceWallets, couponWallets] = await Promise.all([
    fetchOptional(`${origin}/walletd-server/api/v1/subject/profile/peek`),
    fetchOptional(`${origin}/walletd-server/api/v1/subject/wallets?pageSize=5&stage=1&visible=1&serviceable=1`),
    fetchOptional(`${origin}/walletd-server/api/v1/subject/wallets?pageSize=20&stage=3`)
  ]);

  if (authenticationError) {
    await deleteSessionHint(config.id, scopedSessionHint(SILICONFLOW_SESSION_HINT, config.targetUrl));
    throw authenticationError;
  }

  const payloads = [profile, balanceWallets, couponWallets].filter(Boolean);
  if (!payloads.length) return null;
  if (payloads.every((item) => item?.code != null && !siliconflowApiOk(item))) {
    throw new Error(payloads[0]?.message || "SiliconFlow wallet API rejected the request");
  }

  const snapshot = siliconflowApiSnapshot(config, profile, balanceWallets, couponWallets);
  if (!snapshot.balances.length && !snapshot.metrics.length) return null;
  return snapshot;
}

async function collectSiliconflowViaPage(config, context) {
  const page = await tokensFromUrl(
    config.targetUrl,
    SILICONFLOW_LOGIN_HINTS,
    "Current browser is not logged in to SiliconFlow",
    {
      renderFallback: true,
      collectionContext: context,
      shouldUseRenderedTokens: (tokens) => {
        return !parseSiliconflowBalanceTokens(tokens).length && !parseSiliconflowMetricTokens(tokens).length;
      }
    }
  );
  const balances = parseSiliconflowBalanceTokens(page.tokens);
  const metrics = parseSiliconflowMetricTokens(page.tokens);
  return siliconflowSnapshot(config, page.url, balances, metrics, { source: "page" });
}

async function collectSiliconFlow(config, context) {
  try {
    const apiSnapshot = await context.runAttempt(
      "siliconflow-api",
      "network",
      () => collectSiliconflowViaApi(config, context)
    );
    if (apiSnapshot) return apiSnapshot;
  } catch {
    // The attempt is recorded on the collection context before falling back.
  }
  return context.runAttempt(
    "siliconflow-page",
    "page",
    () => collectSiliconflowViaPage(config, context)
  );
}

function selectorRulesForPage(parserRules, pageId) {
  return [
    ...(parserRules.balances || []),
    ...(parserRules.quotas || []),
    ...(parserRules.textMetrics || [])
  ].filter((rule) => (rule.pageId || "main") === pageId)
    .filter((rule) => rule.selector || rule.usedSelector || rule.limitSelector)
    .map((rule) => ({ ...rule }));
}

function hasSelectorRules(parserRules = {}) {
  return [parserRules.balances, parserRules.quotas, parserRules.textMetrics]
    .some((rules) => (rules || []).some((rule) => rule.selector || rule.usedSelector || rule.limitSelector));
}

function hasConfiguredParserRules(parserRules = {}) {
  return [parserRules.balances, parserRules.quotas, parserRules.textMetrics]
    .some((rules) => (rules || []).some((rule) => (
      rule.selector || rule.usedSelector || rule.limitSelector || rule.pattern || rule.valuePattern || rule.staticValue != null
    )));
}

function sameOriginUrl(config, path) {
  const parsed = new URL(config.targetUrl);
  parsed.pathname = path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

async function collectNewApiViaApi(config, { probe = false } = {}) {
  let payload;
  try {
    payload = await fetchNewApiJson(sameOriginUrl(config, "/api/user/self"));
  } catch (error) {
    if (probe) return null;
    if (error instanceof NotLoggedInError) {
      throw new NotLoggedInError(`Current browser is not logged in to ${config.name}`);
    }
    throw error;
  }
  if (!payload || !isNewApiSelfPayload(payload)) return null;
  return newApiSnapshot(config, sameOriginUrl(config, "/dashboard"), payload);
}

function withNewApiFallbackRules(config) {
  if (hasConfiguredParserRules(config.parserRules)) return config;
  return {
    ...config,
    parserRules: {
      loginHints: NEWAPI_LOGIN_HINTS,
      readyPattern: "额度|余额|用量|充值|quota|balance|usage|top up|token",
      balances: [{
        id: "newapi-balance",
        label: "剩余额度",
        pattern: "剩余额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
        valueGroup: 1,
        currency: "USD",
        limit: 1
      }],
      quotas: [{
        id: "newapi-quota-usage",
        label: "额度用量",
        pattern: "已用额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*总额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
        usedGroup: 1,
        limitGroup: 2,
        currency: "USD",
        limit: 1
      }],
      textMetrics: [{
        id: "newapi-request-count",
        label: "请求次数",
        pattern: "请求次数\\s*[:：]?\\s*(\\d+)",
        valueGroup: 1,
        limit: 1
      }]
    }
  };
}

async function collectNewApi(config, context) {
  let authenticationError = null;
  try {
    const apiSnapshot = await context.runAttempt(
      "newapi-api",
      "network",
      () => collectNewApiViaApi(config)
    );
    if (apiSnapshot) return apiSnapshot;
  } catch (error) {
    if (error instanceof NotLoggedInError) authenticationError = error;
  }
  try {
    return await context.runAttempt(
      "newapi-page",
      "page",
      () => collectGenericPage(withNewApiFallbackRules(config), context)
    );
  } catch (error) {
    if (authenticationError && error instanceof NotLoggedInError) throw authenticationError;
    throw error;
  }
}

async function getSub2ApiAuthToken(config, context) {
  return getLocalStorageSessionValue(config, context, {
    storageKey: SUB2API_AUTH_TOKEN_KEY,
    sessionHint: SUB2API_SESSION_HINT,
    ttlMs: SUB2API_SESSION_TTL_MS
  });
}

async function collectSub2ApiViaApi(config, context, { probe = false } = {}) {
  const token = await getSub2ApiAuthToken(config, context);
  if (!token) {
    if (probe) return null;
    throw new NotLoggedInError(`Current browser is not logged in to ${config.name}`);
  }
  try {
    const timezone = encodeURIComponent(SUB2API_API_TIMEZONE);
    const origin = new URL(config.targetUrl).origin;
    const authUrl = `${origin}/api/v1/auth/me?timezone=${timezone}`;
    const statsUrl = `${origin}/api/v1/usage/dashboard/stats?timezone=${timezone}`;
    const authPayload = await fetchSub2ApiJson(authUrl, token, config.name);
    if (!authPayload || !isSub2ApiAuthPayload(authPayload)) return null;
    let statsPayload = null;
    try {
      statsPayload = await fetchSub2ApiJson(statsUrl, token, config.name);
    } catch (error) {
      if (error instanceof NotLoggedInError) throw error;
    }
    return sub2ApiSnapshot(config, sameOriginUrl(config, "/dashboard"), authPayload, statsPayload);
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      await deleteSessionHint(config.id, scopedSessionHint(SUB2API_SESSION_HINT, config.targetUrl));
      if (probe) return null;
    }
    throw error;
  }
}

async function collectSub2ApiViaPage(config, context) {
  const page = await tokensFromUrl(
    config.targetUrl,
    SUB2API_LOGIN_HINTS,
    `Current browser is not logged in to ${config.name}`,
    {
      renderFallback: true,
      requirePathMatch: true,
      waitOptions: {
        ...DEFAULT_RENDER_WAIT_OPTIONS,
        readyPattern: "余额|今日请求|今日消费|累计 Token|AIHub|balance|usage"
      },
      collectionContext: context,
      shouldUseRenderedTokens: (tokens) => !parseSub2ApiDashboardTokens(tokens).metrics.length
    }
  );
  return sub2ApiPageSnapshot(config, page.url, parseSub2ApiDashboardTokens(page.tokens));
}

async function collectSub2Api(config, context) {
  let authenticationError = null;
  try {
    const apiSnapshot = await context.runAttempt(
      "sub2api-api",
      "network",
      () => collectSub2ApiViaApi(config, context)
    );
    if (apiSnapshot) return apiSnapshot;
  } catch (error) {
    if (error instanceof NotLoggedInError) authenticationError = error;
  }
  try {
    return await context.runAttempt(
      "sub2api-page",
      "page",
      () => collectSub2ApiViaPage(config, context)
    );
  } catch (error) {
    if (authenticationError && error instanceof NotLoggedInError) throw authenticationError;
    throw error;
  }
}

async function collectPageProvider(config, context) {
  if (!hasConfiguredParserRules(config.parserRules)) {
    try {
      const apiSnapshot = await context.runAttempt(
        "newapi-auto",
        "network",
        () => collectNewApiViaApi(config, { probe: true })
      );
      if (apiSnapshot) return apiSnapshot;
    } catch {
      // Non-New API pages continue through the generic page collector.
    }
    try {
      const apiSnapshot = await context.runAttempt(
        "sub2api-auto",
        "network",
        () => collectSub2ApiViaApi(config, context, { probe: true })
      );
      if (apiSnapshot) return apiSnapshot;
    } catch {
      // Non-Sub2API pages continue through the generic page collector.
    }
  }
  return context.runAttempt(
    "generic-page",
    "page",
    () => collectGenericPage(config, context)
  );
}

function mergeGenericParsed(left, right) {
  const balances = [...(left.balances || []), ...(right.balances || [])];
  const usage = [...(left.usage || []), ...(right.usage || [])];
  const textMetrics = [...(left.textMetrics || []), ...(right.textMetrics || [])];
  return {
    balances,
    usage,
    textMetrics,
    metrics: [...balances, ...usage, ...textMetrics],
    diagnostics: [...(left.diagnostics || []), ...(right.diagnostics || [])]
  };
}

async function collectGenericPage(config, context) {
  const parserRules = config.parserRules || {};
  const loginHints = Array.isArray(parserRules.loginHints) ? parserRules.loginHints : [];
  const waitOptions = {
    ...DEFAULT_RENDER_WAIT_OPTIONS,
    ...(parserRules.readyPattern ? { readyPattern: parserRules.readyPattern } : {}),
    ...(parserRules.readySelector ? { readySelector: parserRules.readySelector } : {}),
    ...(parserRules.waitOptions || {}),
    loginHints
  };
  const pages = [
    { id: "main", url: config.targetUrl, required: true },
    ...(config.secondaryUrls || []).map((item) => ({ id: item.id, url: item.url, required: false }))
  ];
  const allTokens = [];
  const selectorResults = {};
  let snapshotUrl = config.targetUrl;
  const tabSession = createTabSession(context);
  const afterLoadDelayMs = Number(parserRules.afterLoadDelayMs ?? 0);

  try {
    for (const pageConfig of pages) {
      const pageSelectorRules = selectorRulesForPage(parserRules, pageConfig.id);
      try {
        const page = await tokensFromUrl(
          pageConfig.url,
          loginHints,
          `Current browser is not logged in to ${config.name}`,
          {
            renderFallback: true,
            requirePathMatch: parserRules.requirePathMatch !== false,
            waitOptions,
            selectorRules: pageSelectorRules,
            afterLoadDelayMs,
            collectionContext: context,
            tabSession,
            shouldUseRenderedTokens: (tokens, page) => {
              if (!pageSelectorRules.length) return !parseGenericPageTokens(tokens, parserRules).metrics.length;
              return !Object.values(page?.selectorResults || {}).some((result) => {
                return [result.values, result.usedValues, result.limitValues].some((values) => values?.length);
              });
            }
          }
        );
        if (pageConfig.required) snapshotUrl = page.url;
        allTokens.push(...page.tokens);
        Object.assign(selectorResults, page.selectorResults || {});
      } catch (error) {
        if (error instanceof NotLoggedInError || pageConfig.required || pageSelectorRules.length) throw error;
      }
    }
  } finally {
    await tabSession.close();
  }

  const tokenParsed = parseGenericPageTokens(allTokens, parserRules);
  const selectorParsed = parseGenericSelectorResults(selectorResults, parserRules);
  return genericPageSnapshot(config, snapshotUrl, mergeGenericParsed(tokenParsed, selectorParsed));
}

async function ensureProviderPermission(config) {
  if (!globalThis.chrome?.permissions?.contains) return;
  const origins = originsForConfig(config);
  if (!await chrome.permissions.contains({ origins })) {
    throw new Error(`Open extension settings and grant access to ${origins.join(", ")}`);
  }
}

const providerAdapters = createProviderRegistry([
  ["page", { collect: collectPageProvider }],
  ["opencode", {
    collect: (config, context) => context.runAttempt(
      "opencode-http-or-page",
      "page",
      () => collectOpenCode(config, context)
    )
  }],
  ["deepseek", {
    collect: (config, context) => context.runAttempt(
      "deepseek-api",
      "network",
      () => collectDeepSeek(config)
    )
  }],
  ["ezaiclub", { collect: collectEzaiclub }],
  ["siliconflow", { collect: collectSiliconFlow }],
  ["newapi", { collect: collectNewApi }],
  ["sub2api", { collect: collectSub2Api }]
]);

export function providerAdapterTypes() {
  return providerAdapters.types();
}

export async function collectProvider(config, contextInput = {}) {
  const context = createCollectionContext(contextInput);
  try {
    await ensureProviderPermission(config);
    const adapterType = hasSelectorRules(config.parserRules) ? "page" : config.type;
    const adapter = providerAdapters.get(adapterType);
    if (!adapter) throw new Error(`unsupported provider type: ${config.type}`);
    const snapshot = await adapter.collect(config, context);
    return attachCollectionDiagnostics(snapshot, context);
  } catch (error) {
    throw decorateCollectionError(error, context);
  }
}
