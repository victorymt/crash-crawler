export const DEFAULT_OPENCODE_URL = "https://opencode.ai/workspace/wrk_01KW9MTABWQ0DNJ014CV528WC2/go";
export const DEFAULT_DEEPSEEK_URL = "https://platform.deepseek.com/usage";
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEFAULT_EZAICLUB_DASHBOARD_URL = "https://www.ezaiclub.com/dashboard";
export const DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL = "https://www.ezaiclub.com/subscriptions";
export const DEFAULT_SILICONFLOW_COUPON_URL = "https://cloud.siliconflow.cn/me/expensebill?tab=coupon";
export const NEWAPI_QUOTA_PER_UNIT = 500000;

export const DEFAULT_PROVIDER_CONFIGS = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "opencode",
    targetUrl: DEFAULT_OPENCODE_URL,
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: true,
    secondaryUrls: [],
    mode: "http_then_page"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "deepseek",
    targetUrl: DEFAULT_DEEPSEEK_URL,
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: true,
    secondaryUrls: [],
    mode: "api"
  },
  {
    id: "ezaiclub",
    name: "EZAICLUB",
    type: "ezaiclub",
    targetUrl: DEFAULT_EZAICLUB_DASHBOARD_URL,
    rechargeRatio: 10,
    enabled: true,
    refreshOnVisit: true,
    secondaryUrls: [
      {
        label: "打开订阅页",
        url: DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL
      }
    ],
    mode: "page"
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    type: "siliconflow",
    targetUrl: DEFAULT_SILICONFLOW_COUPON_URL,
    rechargeRatio: 1,
    enabled: true,
    refreshOnVisit: true,
    secondaryUrls: [],
    mode: "page"
  }
];

export const PROVIDER_SCHEMA_VERSION = 4;
export const SUPPORTED_PROVIDER_TYPES = ["page", "opencode", "deepseek", "ezaiclub", "siliconflow", "newapi", "sub2api"];
export const BUILTIN_PROVIDER_IDS = DEFAULT_PROVIDER_CONFIGS.map((config) => config.id);

const MAX_PROVIDERS = 64;
const MAX_SECONDARY_PAGES = 8;
const MAX_RULES_PER_KIND = 32;
const MAX_TOTAL_RULES = 64;
const MAX_REGEX_LENGTH = 512;
const MAX_SELECTOR_LENGTH = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_ID_LENGTH = 100;
const MAX_LABEL_LENGTH = 200;
const MAX_LOGIN_HINTS = 20;
const MAX_LOGIN_HINT_LENGTH = 100;
const RECHARGE_RATIO_LIMITS = [0.01, 1000];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;
const ALLOWED_RULE_ATTRIBUTES = new Set(["textContent", "innerText", "value", "href", "title", "aria-label"]);
const ALLOWED_REGEX_FLAGS = new Set(["i", "m", "s", "u"]);
const WAIT_OPTION_LIMITS = {
  waitMs: [100, 30000],
  minWaitMs: [0, 30000],
  pollMs: [100, 2000],
  stableSamples: [1, 20]
};
const PORTABLE_PROVIDER_KEYS = new Set([
  "schemaVersion", "id", "name", "group", "type", "targetUrl", "rechargeRatio",
  "enabled", "refreshOnVisit", "secondaryUrls", "mode", "parserRules", "quotaPerUnit"
]);
const PORTABLE_PARSER_KEYS = new Set([
  "loginHints", "readySelector", "readyPattern", "waitOptions", "afterLoadDelayMs",
  "requirePathMatch", "balances", "quotas", "textMetrics"
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function urlWithPath(value, path) {
  const parsed = safeUrl(value);
  if (!parsed) return value;
  parsed.pathname = path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function isNewApiTemplateRequest(raw) {
  return ["newapi", "new-api", "oneapi", "one-api"].includes(String(raw?.template || raw?.sourceTemplate || raw?.adapter || "").toLowerCase());
}

function isSub2ApiTemplateRequest(raw) {
  return ["sub2api", "sub-2-api", "aihub"].includes(String(raw?.template || raw?.sourceTemplate || raw?.adapter || "").toLowerCase());
}

function normalizeRechargeRatio(raw, providerType) {
  const value = raw.rechargeRatio ?? raw.recharge_ratio;
  if (value == null || value === "") return providerType === "ezaiclub" ? 10 : 1;
  return Number(value);
}

function newApiParserRules() {
  return {
    loginHints: ["/login", "/user/login", "Sign in to", "Sign up", "用户登录", "登录账号", "登录 / 注册"],
    readyPattern: "额度|余额|用量|充值|quota|balance|usage|top up|token",
    balances: [
      {
        id: "newapi-balance",
        label: "剩余额度",
        pattern: "剩余额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
        valueGroup: 1,
        currency: "USD",
        limit: 1
      }
    ],
    quotas: [
      {
        id: "newapi-quota-usage",
        label: "额度用量",
        pattern: "已用额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*总额度\\s*[:：]?\\s*[$]?\\s*(\\d+(?:\\.\\d+)?)",
        usedGroup: 1,
        limitGroup: 2,
        currency: "USD",
        limit: 1
      }
    ],
    textMetrics: [
      {
        id: "newapi-request-count",
        label: "请求次数",
        pattern: "请求次数\\s*[:：]?\\s*(\\d+)",
        valueGroup: 1,
        limit: 1
      }
    ]
  };
}

function sub2ApiParserRules() {
  return {
    loginHints: ["/login", "登录", "用户登录", "Authorization header is required"],
    readyPattern: "余额|今日请求|总计|今日消费|累计 Token|balance|usage|dashboard|AIHub",
    balances: [
      {
        id: "sub2api-balance",
        label: "余额",
        pattern: "^\\$\\s*(\\d+(?:\\.\\d+)?)$",
        valueGroup: 1,
        currency: "USD",
        limit: 1
      }
    ],
    quotas: [],
    textMetrics: [
      {
        id: "sub2api-today-requests",
        label: "今日请求",
        pattern: "今日请求\\s*(\\d+)",
        valueGroup: 1,
        limit: 1
      }
    ]
  };
}

function normalizeNewApiParserRules(parserRules) {
  const defaults = newApiParserRules();
  return {
    ...(parserRules || defaults),
    loginHints: defaults.loginHints
  };
}

function normalizeSub2ApiParserRules(parserRules) {
  return parserRules || sub2ApiParserRules();
}

function hasParserRuleEntries(parserRules = {}) {
  return [parserRules.balances, parserRules.quotas, parserRules.textMetrics]
    .some((rules) => (rules || []).some((rule) => (
      rule.selector || rule.usedSelector || rule.limitSelector || rule.pattern || rule.valuePattern || rule.staticValue != null
    )));
}

function withNewApiTemplate(config, raw) {
  const targetUrl = config.targetUrl
    ? urlWithPath(config.targetUrl, safeUrl(config.targetUrl)?.pathname === "/" ? "/dashboard" : safeUrl(config.targetUrl)?.pathname || "/dashboard")
    : config.targetUrl;
  const secondaryUrls = config.secondaryUrls.length
    ? config.secondaryUrls
    : [{
        id: "subscriptions",
        label: "打开订阅页",
        url: urlWithPath(targetUrl, "/subscriptions")
      }];
  return {
    ...config,
    type: "newapi",
    mode: String(raw.mode || "api_then_page"),
    targetUrl,
    secondaryUrls,
    parserRules: normalizeNewApiParserRules(hasParserRuleEntries(config.parserRules) ? config.parserRules : null)
  };
}

function withSub2ApiTemplate(config, raw) {
  const targetUrl = config.targetUrl
    ? urlWithPath(config.targetUrl, safeUrl(config.targetUrl)?.pathname === "/" ? "/dashboard" : safeUrl(config.targetUrl)?.pathname || "/dashboard")
    : config.targetUrl;
  const secondaryUrls = config.secondaryUrls.length
    ? config.secondaryUrls
    : [{
        id: "subscriptions",
        label: "打开订阅页",
        url: urlWithPath(targetUrl, "/subscriptions")
      }];
  return {
    ...config,
    type: "sub2api",
    mode: String(raw.mode || "api_then_page"),
    targetUrl,
    secondaryUrls,
    parserRules: normalizeSub2ApiParserRules(hasParserRuleEntries(config.parserRules) ? config.parserRules : null)
  };
}

function normalizeSecondaryUrls(raw) {
  const rawSecondaryUrls = Array.isArray(raw.secondaryUrls) ? raw.secondaryUrls : raw.secondary_urls;
  return Array.isArray(rawSecondaryUrls)
    ? rawSecondaryUrls
        .filter((item) => item && item.url)
        .map((item, index) => ({
          id: String(item.id || `page-${index + 1}`),
          label: String(item.label || "打开详情页"),
          url: String(item.url)
        }))
    : [];
}

function normalizeRuleList(rules, prefix) {
  return Array.isArray(rules)
    ? rules.map((rule, index) => ({
        ...cloneJson(rule),
        id: String(rule.id || `${prefix}-${index + 1}`),
        pageId: String(rule.pageId || "main")
      }))
    : [];
}

function normalizeWaitOptions(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Provider waitOptions must be an object");
  }
  const normalized = {};
  for (const key of Object.keys(WAIT_OPTION_LIMITS)) {
    if (raw[key] != null) normalized[key] = Number(raw[key]);
  }
  return normalized;
}

function normalizeParserRules(rawRules) {
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) return null;
  const rules = cloneJson(rawRules);
  const normalized = {
    loginHints: Array.isArray(rules.loginHints) ? rules.loginHints.map(String).filter(Boolean) : [],
    readySelector: rules.readySelector ? String(rules.readySelector) : "",
    balances: normalizeRuleList(rules.balances, "balance"),
    quotas: normalizeRuleList(rules.quotas, "quota"),
    textMetrics: normalizeRuleList(rules.textMetrics, "text")
  };
  if (rules.readyPattern != null) normalized.readyPattern = String(rules.readyPattern);
  if (rules.waitOptions != null) normalized.waitOptions = normalizeWaitOptions(rules.waitOptions);
  if (rules.afterLoadDelayMs != null) normalized.afterLoadDelayMs = Number(rules.afterLoadDelayMs);
  if (rules.requirePathMatch != null) normalized.requirePathMatch = rules.requirePathMatch !== false;
  return normalized;
}

function validatePortableSchemaShape(raw) {
  const schemaVersion = raw?.schemaVersion ?? raw?.schema_version;
  if (schemaVersion != null && ![1, 2, 3, PROVIDER_SCHEMA_VERSION].includes(schemaVersion)) {
    throw new Error(`Unsupported provider schemaVersion: ${schemaVersion}`);
  }
  if (schemaVersion !== PROVIDER_SCHEMA_VERSION) return;
  const unknown = Object.keys(raw).filter((key) => !PORTABLE_PROVIDER_KEYS.has(key));
  if (unknown.length) throw new Error(`Provider ${raw.id || "<unknown>"} has unsupported fields: ${unknown.join(", ")}`);
  if (raw.parserRules && typeof raw.parserRules === "object" && !Array.isArray(raw.parserRules)) {
    const unknownRules = Object.keys(raw.parserRules).filter((key) => !PORTABLE_PARSER_KEYS.has(key));
    if (unknownRules.length) {
      throw new Error(`Provider ${raw.id || "<unknown>"} parserRules has unsupported fields: ${unknownRules.join(", ")}`);
    }
  }
}

function validateUrl(value, label) {
  if (String(value || "").length > MAX_URL_LENGTH) throw new Error(`${label} is too long`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
}

function regexHasNestedRepetition(pattern) {
  const frames = [{ hasRepetition: false, hasAlternation: false }];
  let escaped = false;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === "(") {
      frames.push({ hasRepetition: false, hasAlternation: false });
      continue;
    }
    if (character === "|") {
      frames.at(-1).hasAlternation = true;
      continue;
    }
    if (character === ")" && frames.length > 1) {
      const frame = frames.pop();
      const quantified = ["*", "+", "?", "{"].includes(pattern[index + 1]);
      const repeatedlyQuantified = ["*", "+", "{"].includes(pattern[index + 1]);
      if (repeatedlyQuantified && (frame.hasRepetition || frame.hasAlternation)) return true;
      if (frame.hasRepetition || quantified) frames.at(-1).hasRepetition = true;
      continue;
    }
    if (["*", "+", "?", "{"].includes(character) && pattern[index - 1] !== "(") {
      frames.at(-1).hasRepetition = true;
    }
  }
  return false;
}

function validateRegex(value, flags, label) {
  if (!value) return;
  const pattern = String(value);
  const normalizedFlags = String(flags || "");
  if (pattern.length > MAX_REGEX_LENGTH) throw new Error(`${label} regex is too long`);
  if ([...normalizedFlags].some((flag) => !ALLOWED_REGEX_FLAGS.has(flag)) || new Set(normalizedFlags).size !== normalizedFlags.length) {
    throw new Error(`${label} regex flags are unsupported`);
  }
  if (/\\[1-9]/.test(pattern) || regexHasNestedRepetition(pattern)) {
    throw new Error(`${label} regex contains unsafe repetition`);
  }
  try {
    new RegExp(pattern, normalizedFlags);
  } catch (error) {
    throw new Error(`${label} regex is invalid: ${error.message}`);
  }
}

function validateIdentifier(value, label) {
  const normalized = String(value || "");
  if (!normalized || normalized.length > MAX_ID_LENGTH || !IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${label} must use 1-${MAX_ID_LENGTH} letters, numbers, dots, underscores, or hyphens`);
  }
}

function validateShortText(value, label, maxLength = MAX_LABEL_LENGTH) {
  if (String(value || "").length > maxLength) throw new Error(`${label} is too long`);
}

function validateSelector(value, label) {
  if (value == null) return;
  const selector = String(value);
  if (!selector.trim()) throw new Error(`${label} has an empty selector`);
  if (selector.length > MAX_SELECTOR_LENGTH) throw new Error(`${label} selector is too long`);
}

function validateWaitOptions(rules, providerId) {
  const options = rules.waitOptions || {};
  for (const [key, [minimum, maximum]] of Object.entries(WAIT_OPTION_LIMITS)) {
    if (options[key] == null) continue;
    if (!Number.isFinite(options[key]) || options[key] < minimum || options[key] > maximum) {
      throw new Error(`Provider ${providerId} waitOptions.${key} must be between ${minimum} and ${maximum}`);
    }
  }
  if (options.waitMs != null && options.minWaitMs != null && options.minWaitMs > options.waitMs) {
    throw new Error(`Provider ${providerId} waitOptions.minWaitMs cannot exceed waitMs`);
  }
  if (rules.afterLoadDelayMs != null && (
    !Number.isFinite(rules.afterLoadDelayMs) || rules.afterLoadDelayMs < 0 || rules.afterLoadDelayMs > 5000
  )) {
    throw new Error(`Provider ${providerId} afterLoadDelayMs must be between 0 and 5000`);
  }
}

function validateParserRules(config) {
  const rules = config.parserRules;
  if (!rules) return;
  if (rules.loginHints.length > MAX_LOGIN_HINTS) throw new Error(`Provider ${config.id} has too many login hints`);
  for (const hint of rules.loginHints) validateShortText(hint, `Provider ${config.id} login hint`, MAX_LOGIN_HINT_LENGTH);
  validateSelector(rules.readySelector || null, `Provider ${config.id} readySelector`);
  validateWaitOptions(rules, config.id);
  for (const [kind, list] of [["balance", rules.balances], ["quota", rules.quotas], ["text metric", rules.textMetrics]]) {
    if (list.length > MAX_RULES_PER_KIND) throw new Error(`Provider ${config.id} has too many ${kind} rules`);
  }
  const pageIds = new Set(["main", ...config.secondaryUrls.map((page) => page.id)]);
  const allRules = [
    ...(rules.balances || []).map((rule) => ["Balance", rule]),
    ...(rules.quotas || []).map((rule) => ["Quota", rule]),
    ...(rules.textMetrics || []).map((rule) => ["Text metric", rule])
  ];
  if (allRules.length > MAX_TOTAL_RULES) throw new Error(`Provider ${config.id} has too many parser rules`);
  const ruleIds = new Set();
  for (const [kind, rule] of allRules) {
    validateIdentifier(rule.id, `${kind} rule id`);
    if (ruleIds.has(rule.id)) throw new Error(`${kind} rule id must be unique`);
    ruleIds.add(rule.id);
    validateShortText(rule.label, `${kind} ${rule.id} label`);
    if (!pageIds.has(rule.pageId || "main")) throw new Error(`${kind} ${rule.label || rule.id} references an unknown page`);
    for (const selector of [rule.selector, rule.usedSelector, rule.limitSelector, rule.resetSelector]) {
      validateSelector(selector, `${kind} ${rule.label || rule.id}`);
    }
    for (const attribute of [rule.attribute, rule.usedAttribute, rule.limitAttribute, rule.resetAttribute]) {
      if (attribute != null && !ALLOWED_RULE_ATTRIBUTES.has(String(attribute))) {
        throw new Error(`${kind} ${rule.label || rule.id} uses an unsupported attribute`);
      }
    }
    validateShortText(rule.key, `${kind} ${rule.label || rule.id} key`, 128);
    validateShortText(rule.currency, `${kind} ${rule.label || rule.id} currency`, 16);
    validateShortText(rule.symbol, `${kind} ${rule.label || rule.id} symbol`, 8);
    validateShortText(rule.staticValue, `${kind} ${rule.label || rule.id} static value`, 10000);
    if (kind === "Balance" && !rule.selector && !rule.pattern) {
      throw new Error(`Balance ${rule.label || rule.id} requires a CSS selector`);
    }
    if (kind === "Quota" && !rule.selector && !(rule.usedSelector && rule.limitSelector) && !rule.pattern) {
      throw new Error(`Quota ${rule.label || rule.id} requires a CSS selector`);
    }
    if (kind === "Quota" && rule.mode === "separate" && !(rule.usedSelector && rule.limitSelector)) {
      throw new Error(`Quota ${rule.label || rule.id} requires both used and limit selectors`);
    }
    if (kind === "Text metric" && !rule.selector && !rule.pattern) {
      throw new Error(`Text metric ${rule.label || rule.id} requires a CSS selector`);
    }
    validateRegex(rule.pattern, rule.flags, `${kind} ${rule.label || rule.id}`);
    validateRegex(rule.usedPattern, rule.usedFlags || rule.flags, `${kind} ${rule.label || rule.id} used`);
    validateRegex(rule.limitPattern, rule.limitFlags || rule.flags, `${kind} ${rule.label || rule.id} limit`);
    validateRegex(rule.resetPattern, rule.resetFlags || rule.flags, `${kind} ${rule.label || rule.id} reset`);
    validateRegex(rule.valuePattern, rule.valueFlags || rule.flags, `${kind} ${rule.label || rule.id} value`);
  }
  validateRegex(rules.readyPattern, "i", `Provider ${config.id} ready pattern`);
}

export function validateProviderConfig(config, existingConfigs = []) {
  validateIdentifier(config.id, "Provider id");
  if (!config.name || !String(config.name).trim()) throw new Error(`Provider ${config.id} name is required`);
  validateShortText(config.name, `Provider ${config.id} name`);
  validateShortText(config.group, `Provider ${config.id} group`);
  validateShortText(config.mode, `Provider ${config.id} mode`, 64);
  if (!SUPPORTED_PROVIDER_TYPES.includes(config.type)) {
    throw new Error(`Unsupported provider type: ${config.type}`);
  }
  validateUrl(config.targetUrl, `Provider ${config.id} targetUrl`);
  const [minRechargeRatio, maxRechargeRatio] = RECHARGE_RATIO_LIMITS;
  if (!Number.isFinite(config.rechargeRatio)
      || config.rechargeRatio < minRechargeRatio
      || config.rechargeRatio > maxRechargeRatio) {
    throw new Error(`Provider ${config.id} rechargeRatio must be between ${minRechargeRatio} and ${maxRechargeRatio}`);
  }
  if (config.quotaPerUnit != null && (!Number.isFinite(config.quotaPerUnit) || config.quotaPerUnit < 1)) {
    throw new Error(`Provider ${config.id} quotaPerUnit must be at least 1`);
  }
  if ((config.secondaryUrls || []).length > MAX_SECONDARY_PAGES) throw new Error(`Provider ${config.id} has too many secondary pages`);
  const pageIds = new Set();
  for (const page of config.secondaryUrls || []) {
    validateIdentifier(page.id, `Provider ${config.id} page id`);
    if (pageIds.has(page.id) || page.id === "main") throw new Error(`Provider ${config.id} page ids must be unique`);
    pageIds.add(page.id);
    validateShortText(page.label, `Provider ${config.id} page ${page.id} label`);
    validateUrl(page.url, `Provider ${config.id} page ${page.label || page.id} URL`);
  }
  if (config.parserRules != null && (typeof config.parserRules !== "object" || Array.isArray(config.parserRules))) {
    throw new Error(`Provider ${config.id} parserRules must be an object`);
  }
  validateParserRules(config);
  const duplicate = existingConfigs.find((item) => item !== config && item.id === config.id);
  if (duplicate) throw new Error(`Provider id already exists: ${config.id}`);
  return config;
}

export function normalizeProviderConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Provider config must be an object");
  validatePortableSchemaShape(raw);
  const parserRules = normalizeParserRules(raw.parserRules ?? raw.parser_rules);
  const requestedType = raw.type == null || raw.type === ""
    ? (isNewApiTemplateRequest(raw) ? "newapi" : isSub2ApiTemplateRequest(raw) ? "sub2api" : "")
    : String(raw.type);
  const config = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: raw.id == null ? "" : String(raw.id),
    name: raw.name == null ? String(raw.id || "") : String(raw.name),
    group: raw.group == null ? "" : String(raw.group).trim(),
    type: requestedType,
    targetUrl: raw.targetUrl || raw.target_url ? String(raw.targetUrl || raw.target_url) : "",
    rechargeRatio: normalizeRechargeRatio(raw, requestedType),
    enabled: raw.enabled !== false,
    refreshOnVisit: (raw.refreshOnVisit ?? raw.refresh_on_visit) === true,
    secondaryUrls: normalizeSecondaryUrls(raw),
    mode: String(raw.mode || "page"),
    ...(parserRules ? { parserRules } : {}),
    ...((raw.quotaPerUnit ?? raw.quota_per_unit) != null
      ? { quotaPerUnit: Number(raw.quotaPerUnit ?? raw.quota_per_unit) }
      : {})
  };
  if (config.type === "newapi" || isNewApiTemplateRequest(raw)) {
    return validateProviderConfig(withNewApiTemplate(config, raw));
  }
  if (config.type === "sub2api" || isSub2ApiTemplateRequest(raw)) {
    return validateProviderConfig(withSub2ApiTemplate(config, raw));
  }
  return validateProviderConfig(config);
}

export function normalizeProviderConfigs(configs) {
  if (!Array.isArray(configs)) throw new Error("Provider configs must be an array");
  if (configs.length > MAX_PROVIDERS) throw new Error(`Provider config limit is ${MAX_PROVIDERS}`);
  const normalized = configs.map(normalizeProviderConfig);
  normalized.forEach((config) => validateProviderConfig(config, normalized));
  return normalized;
}

export function providersFromImportDocument(document) {
  if (Array.isArray(document)) return document;
  if (!document || typeof document !== "object") {
    throw new Error("Provider import must be an object or array");
  }
  const schemaVersion = document.schemaVersion ?? document.schema_version;
  if (schemaVersion != null && ![1, 2, 3, PROVIDER_SCHEMA_VERSION].includes(schemaVersion)) {
    throw new Error(`Unsupported provider schemaVersion: ${schemaVersion}`);
  }
  if (Array.isArray(document.providers)) return document.providers;
  if (document.id != null) return [document];
  throw new Error("Provider import is missing a providers array");
}

export function upsertProviderConfig(configs, rawProvider) {
  const provider = normalizeProviderConfig(rawProvider);
  const next = [...configs];
  const index = next.findIndex((item) => item.id === provider.id);
  if (index >= 0) next[index] = provider;
  else next.push(provider);
  return normalizeProviderConfigs(next);
}

export function isBuiltinProviderId(providerId) {
  return BUILTIN_PROVIDER_IDS.includes(String(providerId));
}

export function originsForConfig(config) {
  const urls = [config.targetUrl, ...(config.secondaryUrls || []).map((item) => item.url)];
  return [...new Set(urls.map((url) => {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/*`;
  }))];
}

export function linksForConfig(config) {
  return [
    { label: "打开官方页面", url: config.targetUrl },
    ...(config.secondaryUrls || [])
  ];
}
