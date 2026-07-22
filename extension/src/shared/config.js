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

export function normalizeProviderConfig(raw) {
  const secondaryUrls = Array.isArray(raw.secondaryUrls)
    ? raw.secondaryUrls
        .filter((item) => item && item.url)
        .map((item) => ({
          label: String(item.label || "打开详情页"),
          url: String(item.url)
        }))
    : [];
  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    type: String(raw.type),
    targetUrl: String(raw.targetUrl || raw.target_url),
    enabled: raw.enabled !== false,
    secondaryUrls,
    mode: String(raw.mode || "page")
  };
}

export function linksForConfig(config) {
  return [
    { label: "打开官方页面", url: config.targetUrl },
    ...(config.secondaryUrls || [])
  ];
}
