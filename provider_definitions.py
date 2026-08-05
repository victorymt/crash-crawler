"""Stable Provider registration data shared by local runtime consumers."""

from __future__ import annotations

from dataclasses import dataclass


PROVIDER_CAPABILITY_CHANNELS = "channels"
PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH = "local-sync-auth"
PROVIDER_CAPABILITY_AUTO_DETECT = "auto-detect"
PROVIDER_CAPABILITY_API_ONLY = "api-only"


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    type: str
    default_mode: str = "page"
    capabilities: frozenset[str] = frozenset()

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities


_PROVIDER_DEFINITIONS = (
    ProviderDefinition("page"),
    ProviderDefinition("opencode", default_mode="http_then_page"),
    ProviderDefinition(
        "deepseek",
        default_mode="api",
        capabilities=frozenset({PROVIDER_CAPABILITY_API_ONLY}),
    ),
    ProviderDefinition(
        "ezaiclub",
        capabilities=frozenset({
            PROVIDER_CAPABILITY_CHANNELS,
            PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH,
        }),
    ),
    ProviderDefinition("siliconflow"),
    ProviderDefinition(
        "newapi",
        default_mode="api_then_page",
        capabilities=frozenset({PROVIDER_CAPABILITY_AUTO_DETECT}),
    ),
    ProviderDefinition(
        "sub2api",
        default_mode="api_then_page",
        capabilities=frozenset({
            PROVIDER_CAPABILITY_CHANNELS,
            PROVIDER_CAPABILITY_LOCAL_SYNC_AUTH,
            PROVIDER_CAPABILITY_AUTO_DETECT,
        }),
    ),
)

_DEFINITIONS_BY_TYPE = {definition.type: definition for definition in _PROVIDER_DEFINITIONS}


def provider_definitions() -> tuple[ProviderDefinition, ...]:
    return _PROVIDER_DEFINITIONS


def provider_definition_types() -> tuple[str, ...]:
    return tuple(definition.type for definition in _PROVIDER_DEFINITIONS)


def provider_definition_documents() -> list[dict[str, object]]:
    return [
        {
            "type": definition.type,
            "defaultMode": definition.default_mode,
            "capabilities": sorted(definition.capabilities),
        }
        for definition in _PROVIDER_DEFINITIONS
    ]


def get_provider_definition(provider_type: str) -> ProviderDefinition | None:
    return _DEFINITIONS_BY_TYPE.get(provider_type)


def default_provider_mode(provider_type: str) -> str:
    definition = get_provider_definition(provider_type)
    return definition.default_mode if definition else "page"


def provider_supports_capability(provider_type: str, capability: str) -> bool:
    definition = get_provider_definition(provider_type)
    return definition.supports(capability) if definition else False
