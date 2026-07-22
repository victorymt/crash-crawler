export const DEFAULT_OPENCODE_URL = "https://opencode.ai/workspace/wrk_01KW9MTABWQ0DNJ014CV528WC2/go";
export const DEFAULT_DEEPSEEK_URL = "https://platform.deepseek.com/usage";
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEFAULT_EZAICLUB_DASHBOARD_URL = "https://www.ezaiclub.com/dashboard";
export const DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL = "https://www.ezaiclub.com/subscriptions";
export const DEFAULT_SILICONFLOW_COUPON_URL = "https://cloud.siliconflow.cn/me/expensebill?tab=coupon";

export const DEFAULT_PROVIDER_CONFIGS = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "opencode",
    targetUrl: DEFAULT_OPENCODE_URL,
    enabled: true,
    secondaryUrls: [],
    mode: "http_then_page"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "deepseek",
    targetUrl: DEFAULT_DEEPSEEK_URL,
    enabled: true,
    secondaryUrls: [],
    mode: "api"
  },
  {
    id: "ezaiclub",
    name: "EZAICLUB",
    type: "ezaiclub",
    targetUrl: DEFAULT_EZAICLUB_DASHBOARD_URL,
    enabled: true,
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
    enabled: true,
    secondaryUrls: [],
    mode: "page"
  }
];

export const PROVIDER_SCHEMA_VERSION = 2;
export const SUPPORTED_PROVIDER_TYPES = ["page", "opencode", "deepseek", "ezaiclub", "siliconflow"];
export const BUILTIN_PROVIDER_IDS = DEFAULT_PROVIDER_CONFIGS.map((config) => config.id);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function normalizeParserRules(rawRules) {
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) return null;
  const rules = cloneJson(rawRules);
  return {
    ...rules,
    loginHints: Array.isArray(rules.loginHints) ? rules.loginHints.map(String).filter(Boolean) : [],
    readySelector: rules.readySelector ? String(rules.readySelector) : "",
    balances: normalizeRuleList(rules.balances, "balance"),
    quotas: normalizeRuleList(rules.quotas, "quota"),
    textMetrics: normalizeRuleList(rules.textMetrics, "text")
  };
}

function validateUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
}

function validateRegex(value, label) {
  if (!value) return;
  try {
    new RegExp(value);
  } catch (error) {
    throw new Error(`${label} regex is invalid: ${error.message}`);
  }
}

function validateParserRules(config) {
  const rules = config.parserRules;
  if (!rules) return;
  const pageIds = new Set(["main", ...config.secondaryUrls.map((page) => page.id)]);
  const allRules = [
    ...(rules.balances || []).map((rule) => ["Balance", rule]),
    ...(rules.quotas || []).map((rule) => ["Quota", rule]),
    ...(rules.textMetrics || []).map((rule) => ["Text metric", rule])
  ];
  const ruleIds = new Set();
  for (const [kind, rule] of allRules) {
    if (!rule.id || ruleIds.has(rule.id)) throw new Error(`${kind} rule id must be unique`);
    ruleIds.add(rule.id);
    if (!pageIds.has(rule.pageId || "main")) throw new Error(`${kind} ${rule.label || rule.id} references an unknown page`);
    for (const selector of [rule.selector, rule.usedSelector, rule.limitSelector, rule.resetSelector]) {
      if (selector != null && !String(selector).trim()) throw new Error(`${kind} ${rule.label || rule.id} has an empty selector`);
    }
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
    validateRegex(rule.pattern, `${kind} ${rule.label || rule.id}`);
    validateRegex(rule.usedPattern, `${kind} ${rule.label || rule.id} used`);
    validateRegex(rule.limitPattern, `${kind} ${rule.label || rule.id} limit`);
    validateRegex(rule.resetPattern, `${kind} ${rule.label || rule.id} reset`);
  }
  validateRegex(rules.readyPattern, `Provider ${config.id} ready pattern`);
}

export function validateProviderConfig(config, existingConfigs = []) {
  if (!config.id || !String(config.id).trim()) throw new Error("Provider id is required");
  if (!config.name || !String(config.name).trim()) throw new Error(`Provider ${config.id} name is required`);
  if (!SUPPORTED_PROVIDER_TYPES.includes(config.type)) {
    throw new Error(`Unsupported provider type: ${config.type}`);
  }
  validateUrl(config.targetUrl, `Provider ${config.id} targetUrl`);
  const pageIds = new Set();
  for (const page of config.secondaryUrls || []) {
    if (!page.id || pageIds.has(page.id) || page.id === "main") throw new Error(`Provider ${config.id} page ids must be unique`);
    pageIds.add(page.id);
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
  const parserRules = normalizeParserRules(raw.parserRules);
  const config = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: raw.id == null ? "" : String(raw.id),
    name: raw.name == null ? String(raw.id || "") : String(raw.name),
    type: raw.type == null ? "" : String(raw.type),
    targetUrl: raw.targetUrl || raw.target_url ? String(raw.targetUrl || raw.target_url) : "",
    enabled: raw.enabled !== false,
    secondaryUrls: normalizeSecondaryUrls(raw),
    mode: String(raw.mode || "page"),
    ...(parserRules ? { parserRules } : {})
  };
  return validateProviderConfig(config);
}

export function normalizeProviderConfigs(configs) {
  const normalized = configs.map(normalizeProviderConfig);
  normalized.forEach((config) => validateProviderConfig(config, normalized));
  return normalized;
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
