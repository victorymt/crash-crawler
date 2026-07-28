import { DEEPSEEK_BALANCE_URL, originsForConfig } from "../shared/config.js";
import {
  NotLoggedInError,
  OPENCODE_LOGIN_HINTS,
  EZAICLUB_LOGIN_HINTS,
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
  parseOpencodeBalanceTokens,
  parseOpencodeLegacy,
  parseSiliconflowBalanceTokens,
  parseSiliconflowMetricTokens,
  siliconflowApiSnapshot,
  siliconflowSnapshot
} from "../shared/parsers.js";
import { blankSnapshot } from "../shared/snapshots.js";
import { getSecret } from "../shared/storage.js";

const EZAICLUB_AUTH_TOKEN_KEY = "auth_token";
const EZAICLUB_API_TIMEZONE = "Asia/Shanghai";
const SILICONFLOW_SUBJECT_PROBE = "sf-subject-id";
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

export function isApiProvider(config) {
  return config?.mode === "api" || config?.type === "deepseek";
}

/** Reuse one background tab across multiple navigations (same provider multi-page). */
export function createTabSession() {
  let tabId = null;
  return {
    async load(url, options = {}) {
      if (!chrome.tabs || !chrome.scripting) return null;
      if (tabId == null) {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id ?? null;
      } else if (chrome.tabs.update) {
        await chrome.tabs.update(tabId, { url });
      } else {
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // ignore
        }
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id ?? null;
      }
      if (tabId == null) return null;
      await waitForTabComplete(tabId);
      const delayMs = Number(options.afterLoadDelayMs ?? 0);
      if (delayMs > 0) await delay(delayMs);
      return extractTokensFromTab(tabId, options.waitOptions, options.selectorRules || []);
    },
    async close() {
      if (tabId == null) return;
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The user or browser may already have closed the tab.
      }
      tabId = null;
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
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error(`Timed out after ${timeoutMs}ms while loading browser tab`)), timeoutMs);
    function done(error = null) {
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
  });
}

async function getOpenTabTokens(url, options = {}) {
  if (!chrome.tabs || !chrome.scripting) return null;
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
  const session = createTabSession();
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

async function getEzaiclubAuthToken(config) {
  if (!chrome.scripting?.executeScript) return "";
  const origin = new URL(config.targetUrl).origin;
  const target = new URL(config.targetUrl);

  if (chrome.tabs?.query) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const ranked = [...tabs]
      .filter((tab) => tab.id != null && tab.url)
      .sort((left, right) => tabMatchScore(right.url, target) - tabMatchScore(left.url, target));
    for (const tab of ranked) {
      const token = await readTabLocalStorageKey(tab.id, EZAICLUB_AUTH_TOKEN_KEY);
      if (token) return token;
    }
  }

  // No usable open tab: open dashboard briefly only to read localStorage (no long DOM wait).
  if (!chrome.tabs?.create) return "";
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: config.targetUrl, active: false });
    tabId = tab.id ?? null;
    if (tabId == null) return "";
    await waitForTabComplete(tabId, 15000);
    // SPA writes auth_token after boot; poll briefly instead of full render scrape.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = await readTabLocalStorageKey(tabId, EZAICLUB_AUTH_TOKEN_KEY);
      if (token) return token;
      await delay(300);
    }
    return "";
  } catch {
    return "";
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Tab may already be closed.
      }
    }
  }
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

async function collectEzaiclubViaApi(config) {
  const token = await getEzaiclubAuthToken(config);
  if (!token) return null;
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
}

async function collectEzaiclubViaPage(config) {
  const tabSession = createTabSession();
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

async function collectEzaiclub(config) {
  try {
    const apiSnapshot = await collectEzaiclubViaApi(config);
    if (apiSnapshot) return apiSnapshot;
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      // Token missing/expired: fall back to DOM scrape which surfaces login state.
    } else {
      // API shape/network failures fall back to the existing page collectors.
    }
  }
  return collectEzaiclubViaPage(config);
}

async function readTabSiliconflowSubjectId(tabId) {
  if (!chrome.scripting?.executeScript || tabId == null) return "";
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
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

async function getSiliconflowSubjectId(config) {
  if (!chrome.scripting?.executeScript) return "";
  const origin = new URL(config.targetUrl).origin;
  const target = new URL(config.targetUrl);

  if (chrome.tabs?.query) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const ranked = [...tabs]
      .filter((tab) => tab.id != null && tab.url)
      .sort((left, right) => tabMatchScore(right.url, target) - tabMatchScore(left.url, target));
    for (const tab of ranked) {
      const subjectId = await readTabSiliconflowSubjectId(tab.id);
      if (subjectId) return subjectId;
    }
  }

  if (!chrome.tabs?.create) return "";
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: config.targetUrl, active: false });
    tabId = tab.id ?? null;
    if (tabId == null) return "";
    await waitForTabComplete(tabId, 15000);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const subjectId = await readTabSiliconflowSubjectId(tabId);
      if (subjectId) return subjectId;
      await delay(300);
    }
    return "";
  } catch {
    return "";
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // ignore
      }
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

async function collectSiliconflowViaApi(config) {
  const subjectId = await getSiliconflowSubjectId(config);
  if (!subjectId) return null;
  const origin = "https://cloud.siliconflow.cn";
  const [profile, balanceWallets, couponWallets] = await Promise.all([
    fetchSiliconflowJson(`${origin}/walletd-server/api/v1/subject/profile/peek`, subjectId).catch(() => null),
    fetchSiliconflowJson(
      `${origin}/walletd-server/api/v1/subject/wallets?pageSize=5&stage=1&visible=1&serviceable=1`,
      subjectId
    ).catch(() => null),
    fetchSiliconflowJson(
      `${origin}/walletd-server/api/v1/subject/wallets?pageSize=20&stage=3`,
      subjectId
    ).catch(() => null)
  ]);

  const payloads = [profile, balanceWallets, couponWallets].filter(Boolean);
  if (!payloads.length) return null;
  if (payloads.every((item) => item?.code != null && !siliconflowApiOk(item))) {
    throw new Error(payloads[0]?.message || "SiliconFlow wallet API rejected the request");
  }

  const snapshot = siliconflowApiSnapshot(config, profile, balanceWallets, couponWallets);
  if (!snapshot.balances.length && !snapshot.metrics.length) return null;
  return snapshot;
}

async function collectSiliconflowViaPage(config) {
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
  return siliconflowSnapshot(config, page.url, balances, metrics, { source: "page" });
}

async function collectSiliconFlow(config) {
  try {
    const apiSnapshot = await collectSiliconflowViaApi(config);
    if (apiSnapshot) return apiSnapshot;
  } catch {
    // Fall back to DOM scrape for login walls or API shape changes.
  }
  return collectSiliconflowViaPage(config);
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

async function collectGenericPage(config) {
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
  const tabSession = createTabSession();
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

export async function collectProvider(config) {
  await ensureProviderPermission(config);
  if (hasSelectorRules(config.parserRules)) return collectGenericPage(config);
  if (config.type === "opencode") return collectOpenCode(config);
  if (config.type === "deepseek") return collectDeepSeek(config);
  if (config.type === "ezaiclub") return collectEzaiclub(config);
  if (config.type === "siliconflow") return collectSiliconFlow(config);
  if (config.type === "page") return collectGenericPage(config);
  throw new Error(`unsupported provider type: ${config.type}`);
}
