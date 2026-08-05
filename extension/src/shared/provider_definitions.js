export const PROVIDER_CAPABILITIES = Object.freeze({
  CHANNELS: "channels",
  LOCAL_SYNC_AUTH: "local-sync-auth",
  AUTO_DETECT: "auto-detect",
  API_ONLY: "api-only"
});

function defineProvider(type, { defaultMode = "page", capabilities = [] } = {}) {
  return Object.freeze({
    type,
    defaultMode,
    capabilities: Object.freeze([...capabilities])
  });
}

export const PROVIDER_DEFINITIONS = Object.freeze([
  defineProvider("page"),
  defineProvider("opencode", { defaultMode: "http_then_page" }),
  defineProvider("deepseek", {
    defaultMode: "api",
    capabilities: [PROVIDER_CAPABILITIES.API_ONLY]
  }),
  defineProvider("ezaiclub", {
    capabilities: [
      PROVIDER_CAPABILITIES.CHANNELS,
      PROVIDER_CAPABILITIES.LOCAL_SYNC_AUTH
    ]
  }),
  defineProvider("siliconflow"),
  defineProvider("newapi", {
    defaultMode: "api_then_page",
    capabilities: [PROVIDER_CAPABILITIES.AUTO_DETECT]
  }),
  defineProvider("sub2api", {
    defaultMode: "api_then_page",
    capabilities: [
      PROVIDER_CAPABILITIES.CHANNELS,
      PROVIDER_CAPABILITIES.LOCAL_SYNC_AUTH,
      PROVIDER_CAPABILITIES.AUTO_DETECT
    ]
  })
]);

const DEFINITIONS_BY_TYPE = new Map(
  PROVIDER_DEFINITIONS.map((definition) => [definition.type, definition])
);

export function providerDefinitionTypes() {
  return PROVIDER_DEFINITIONS.map((definition) => definition.type);
}

export function getProviderDefinition(type) {
  return DEFINITIONS_BY_TYPE.get(type) || null;
}

export function defaultProviderMode(type) {
  return getProviderDefinition(type)?.defaultMode || "page";
}

export function providerSupportsCapability(type, capability) {
  return getProviderDefinition(type)?.capabilities.includes(capability) === true;
}
