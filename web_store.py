"""Persistent provider configuration and local web settings."""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from providers import CONFIG_FILE, ProviderConfig, default_config

SUPPORTED_PROVIDER_TYPES = {"page", "opencode", "deepseek", "ezaiclub", "siliconflow", "newapi", "sub2api"}
DEFAULT_SETTINGS = {"auto_refresh_minutes": 0}
MAX_PROVIDERS = 64
SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "provider-config-v4.schema.json"
PORTABLE_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
PORTABLE_PROVIDER_KEYS = frozenset(
    PORTABLE_SCHEMA["$defs"]["provider"]["properties"]
)
PORTABLE_PARSER_KEYS = frozenset(
    PORTABLE_SCHEMA["$defs"]["parserRules"]["properties"]
)


def _validate_url(value: str, label: str) -> None:
    if len(value) > 2048:
        raise ValueError(f"{label} is too long")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError(f"{label} must not contain credentials")


def _regex_has_nested_repetition(pattern: str) -> bool:
    frames = [{"repetition": False, "alternation": False}]
    escaped = False
    in_character_class = False
    for index, character in enumerate(pattern):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == "[":
            in_character_class = True
            continue
        if character == "]" and in_character_class:
            in_character_class = False
            continue
        if in_character_class:
            continue
        if character == "(":
            frames.append({"repetition": False, "alternation": False})
            continue
        if character == "|":
            frames[-1]["alternation"] = True
            continue
        if character == ")" and len(frames) > 1:
            frame = frames.pop()
            following = pattern[index + 1] if index + 1 < len(pattern) else ""
            repeatedly_quantified = bool(following) and following in "*+{"
            if repeatedly_quantified and (frame["repetition"] or frame["alternation"]):
                return True
            if frame["repetition"] or (following and following in "*+?{"):
                frames[-1]["repetition"] = True
            continue
        if character in "*+?{" and (index == 0 or pattern[index - 1] != "("):
            frames[-1]["repetition"] = True
    return False


def validate_provider(config: ProviderConfig) -> None:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", config.id):
        raise ValueError("Provider id must contain only letters, numbers, dot, underscore, or hyphen")
    if not config.name.strip() or len(config.name) > 200:
        raise ValueError("Provider name must be between 1 and 200 characters")
    if config.type not in SUPPORTED_PROVIDER_TYPES:
        raise ValueError(f"Unsupported provider type: {config.type}")
    _validate_url(config.target_url, "Provider target_url")
    if len(config.group) > 200:
        raise ValueError("Provider group is too long")
    if not config.mode or len(config.mode) > 64:
        raise ValueError(f"Provider {config.id} mode must be between 1 and 64 characters")
    if not 0.01 <= config.recharge_ratio <= 1000:
        raise ValueError("Provider recharge_ratio must be between 0.01 and 1000")
    if config.quota_per_unit < 1:
        raise ValueError(f"Provider {config.id} quota_per_unit must be at least 1")
    page_ids = {"main"}
    for page in config.secondary_urls or []:
        page_id = str(page.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", page_id) or page_id in page_ids:
            raise ValueError(f"Provider {config.id} secondary page ids must be unique identifiers")
        page_ids.add(page_id)
        _validate_url(str(page.get("url") or ""), "Secondary page URL")
    if len(config.secondary_urls or []) > 8:
        raise ValueError(f"Provider {config.id} has too many secondary pages")
    _validate_parser_rules(config, page_ids)


def _validate_parser_rules(config: ProviderConfig, page_ids: set[str]) -> None:
    rules = config.parser_rules
    if rules is None:
        if config.type == "page":
            raise ValueError(f"Provider {config.id} page type requires parser_rules")
        return
    if not isinstance(rules, dict):
        raise ValueError(f"Provider {config.id} parser_rules must be an object")
    login_hints = rules.get("loginHints", [])
    if not isinstance(login_hints, list) or len(login_hints) > 20:
        raise ValueError(f"Provider {config.id} has too many login hints")
    if any(len(str(hint)) > 100 for hint in login_hints):
        raise ValueError(f"Provider {config.id} login hint is too long")
    ready_selector = rules.get("readySelector")
    if ready_selector not in (None, "") and (
        not str(ready_selector).strip() or len(str(ready_selector)) > 1000
    ):
        raise ValueError(f"Provider {config.id} ready selector is invalid")
    wait_options = rules.get("waitOptions", {})
    if not isinstance(wait_options, dict):
        raise ValueError(f"Provider {config.id} waitOptions must be an object")
    for key, minimum, maximum in (
        ("waitMs", 100, 30000), ("minWaitMs", 0, 30000),
        ("pollMs", 100, 2000), ("stableSamples", 1, 20),
    ):
        if wait_options.get(key) is not None and not minimum <= float(wait_options[key]) <= maximum:
            raise ValueError(f"Provider {config.id} waitOptions.{key} is out of range")
    if (
        wait_options.get("waitMs") is not None
        and wait_options.get("minWaitMs") is not None
        and float(wait_options["minWaitMs"]) > float(wait_options["waitMs"])
    ):
        raise ValueError(f"Provider {config.id} waitOptions.minWaitMs cannot exceed waitMs")
    if rules.get("afterLoadDelayMs") is not None and not 0 <= float(rules["afterLoadDelayMs"]) <= 5000:
        raise ValueError(f"Provider {config.id} afterLoadDelayMs is out of range")
    all_rules = []
    for key in ("balances", "quotas", "textMetrics"):
        items = rules.get(key, [])
        if not isinstance(items, list) or len(items) > 32:
            raise ValueError(f"Provider {config.id} {key} must contain at most 32 rules")
        all_rules.extend(items)
    if len(all_rules) > 64:
        raise ValueError(f"Provider {config.id} has too many parser rules")
    rule_ids = set()
    allowed_attributes = {"textContent", "innerText", "value", "href", "title", "aria-label"}
    for rule in all_rules:
        if not isinstance(rule, dict):
            raise ValueError(f"Provider {config.id} parser rule must be an object")
        rule_id = str(rule.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", rule_id) or rule_id in rule_ids:
            raise ValueError(f"Provider {config.id} parser rule ids must be unique identifiers")
        rule_ids.add(rule_id)
        if len(str(rule.get("label") or "")) > 200:
            raise ValueError(f"Provider {config.id} parser rule label is too long")
        if str(rule.get("pageId") or "main") not in page_ids:
            raise ValueError(f"Provider {config.id} parser rule references an unknown page")
        for key in ("selector", "usedSelector", "limitSelector", "resetSelector"):
            if rule.get(key) is not None and not 0 < len(str(rule[key])) <= 1000:
                raise ValueError(f"Provider {config.id} parser selector is invalid")
        for key in ("attribute", "usedAttribute", "limitAttribute", "resetAttribute"):
            if rule.get(key) is not None and str(rule[key]) not in allowed_attributes:
                raise ValueError(f"Provider {config.id} parser attribute is unsupported")
        for pattern_key, flags_key in (
            ("pattern", "flags"), ("usedPattern", "usedFlags"),
            ("limitPattern", "limitFlags"), ("resetPattern", "resetFlags"),
            ("valuePattern", "valueFlags"),
        ):
            pattern = str(rule.get(pattern_key) or "")
            flags = str(rule.get(flags_key) or rule.get("flags") or "")
            if (
                len(pattern) > 512
                or any(character not in "imsu" for character in flags)
                or len(set(flags)) != len(flags)
            ):
                raise ValueError(f"Provider {config.id} parser regex is unsupported")
            if pattern:
                if re.search(r"\\[1-9]", pattern) or _regex_has_nested_repetition(pattern):
                    raise ValueError(f"Provider {config.id} parser regex contains unsafe repetition")
                try:
                    re.compile(pattern)
                except re.error as exc:
                    raise ValueError(f"Provider {config.id} parser regex is invalid: {exc}") from exc
        kind = next((key for key in ("balances", "quotas", "textMetrics") if rule in rules.get(key, [])), "")
        has_combined_source = bool(rule.get("selector") or rule.get("pattern"))
        if kind == "quotas" and rule.get("mode") == "separate":
            if not (rule.get("usedSelector") and rule.get("limitSelector")):
                raise ValueError(f"Provider {config.id} quota rule requires used and limit selectors")
        elif kind == "quotas":
            has_combined_source = has_combined_source or bool(
                rule.get("usedSelector") and rule.get("limitSelector")
            )
        if not has_combined_source:
            raise ValueError(f"Provider {config.id} parser rule requires a selector or pattern")
    ready_pattern = str(rules.get("readyPattern") or "")
    if len(ready_pattern) > 512 or re.search(r"\\[1-9]", ready_pattern) or _regex_has_nested_repetition(ready_pattern):
        raise ValueError(f"Provider {config.id} ready regex is unsafe")
    if ready_pattern:
        try:
            re.compile(ready_pattern)
        except re.error as exc:
            raise ValueError(f"Provider {config.id} ready regex is invalid: {exc}") from exc


def normalize_settings(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    minutes = source.get("auto_refresh_minutes", source.get("autoRefreshMinutes", 0))
    try:
        normalized_minutes = int(minutes or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("auto_refresh_minutes must be a number") from exc
    if normalized_minutes not in {0, 15, 30, 60, 120, 360}:
        raise ValueError("auto_refresh_minutes is not an allowed interval")
    return {"auto_refresh_minutes": normalized_minutes}


def providers_from_import_document(document: Any) -> list[Any]:
    if isinstance(document, list):
        providers = document
    elif isinstance(document, dict) and isinstance(document.get("providers"), list):
        providers = document["providers"]
    elif isinstance(document, dict) and document.get("id") is not None:
        providers = [document]
    else:
        raise ValueError("Provider import must be a provider, an array, or an object with providers")
    if not providers:
        raise ValueError("Provider import is empty")
    _validate_portable_schema_shape(document, providers)
    return providers


def _validate_portable_schema_shape(document: Any, providers: list[Any]) -> None:
    wrapper_version = (
        document.get("schemaVersion", document.get("schema_version"))
        if isinstance(document, dict)
        else None
    )
    if wrapper_version not in (None, 1, 2, 3, 4):
        raise ValueError("Unsupported provider schemaVersion")
    if wrapper_version in (1, 2, 3):
        return
    for provider in providers:
        if not isinstance(provider, dict):
            continue
        provider_version = provider.get("schemaVersion", provider.get("schema_version"))
        if provider_version not in (None, 1, 2, 3, 4):
            raise ValueError(f"Unsupported provider schemaVersion: {provider_version}")
        if provider_version != 4:
            continue
        unknown = set(provider) - PORTABLE_PROVIDER_KEYS
        if unknown:
            raise ValueError(f"Provider {provider.get('id') or '<unknown>'} has unsupported fields: {', '.join(sorted(unknown))}")
        parser_rules = provider.get("parserRules")
        if isinstance(parser_rules, dict):
            unknown_rules = set(parser_rules) - PORTABLE_PARSER_KEYS
            if unknown_rules:
                raise ValueError(
                    f"Provider {provider.get('id') or '<unknown>'} parserRules has unsupported fields: "
                    f"{', '.join(sorted(unknown_rules))}"
                )


class ConfigStore:
    def __init__(self, path: Path = CONFIG_FILE) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._configs, self._settings = self._load()

    def _load(self) -> tuple[list[ProviderConfig], dict[str, Any]]:
        document = default_config()
        if self.path.exists():
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict) or not isinstance(loaded.get("providers"), list):
                raise ValueError(f"invalid provider config: {self.path}")
            document = loaded
        configs = [ProviderConfig.from_dict(item) for item in document["providers"]]
        self._validate_all(configs)
        return configs, normalize_settings(document.get("settings"))

    def _validate_all(self, configs: list[ProviderConfig]) -> None:
        if not configs or len(configs) > MAX_PROVIDERS:
            raise ValueError(f"Provider count must be between 1 and {MAX_PROVIDERS}")
        ids: set[str] = set()
        for config in configs:
            validate_provider(config)
            if config.id in ids:
                raise ValueError(f"Duplicate provider id: {config.id}")
            ids.add(config.id)

    def _save(self) -> None:
        document = {
            "providers": [config.to_dict() for config in self._configs],
            "settings": self._settings,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.path)

    def snapshot(self) -> tuple[list[ProviderConfig], dict[str, Any]]:
        with self._lock:
            return list(self._configs), dict(self._settings)

    def replace(self, raw_configs: list[Any]) -> list[ProviderConfig]:
        configs = [ProviderConfig.from_dict(item) for item in raw_configs]
        self._validate_all(configs)
        with self._lock:
            self._configs = configs
            self._save()
            return list(self._configs)

    def import_configs(
        self,
        raw_configs: list[Any],
        mode: str = "merge",
    ) -> tuple[list[ProviderConfig], dict[str, int]]:
        with self._lock:
            next_configs, summary = self._plan_import(raw_configs, mode)
            self._configs = next_configs
            self._save()
            return list(self._configs), summary

    def preview_import(
        self,
        raw_configs: list[Any],
        mode: str = "merge",
    ) -> tuple[list[ProviderConfig], dict[str, int]]:
        with self._lock:
            return self._plan_import(raw_configs, mode)

    def _plan_import(
        self,
        raw_configs: list[Any],
        mode: str = "merge",
    ) -> tuple[list[ProviderConfig], dict[str, int]]:
        if mode not in {"merge", "replace"}:
            raise ValueError("Provider import mode must be merge or replace")
        _validate_portable_schema_shape(raw_configs, raw_configs)
        imported = [ProviderConfig.from_dict(item) for item in raw_configs]
        self._validate_all(imported)
        current = list(self._configs)
        current_by_id = {config.id: config for config in current}
        imported_by_id = {config.id: config for config in imported}
        if mode == "replace":
            next_configs = imported
        else:
            next_configs = [imported_by_id.get(config.id, config) for config in current]
            next_configs.extend(
                config for config in imported if config.id not in current_by_id
            )
        self._validate_all(next_configs)
        added = sum(config.id not in current_by_id for config in imported)
        unchanged = sum(
            config.id in current_by_id
            and config.to_dict() == current_by_id[config.id].to_dict()
            for config in imported
        )
        updated = len(imported) - added - unchanged
        removed = sum(config.id not in imported_by_id for config in current) if mode == "replace" else 0
        return next_configs, {
            "added": added,
            "updated": updated,
            "unchanged": unchanged,
            "removed": removed,
            "total": len(next_configs),
        }

    def upsert(self, raw_config: Any) -> ProviderConfig:
        incoming = ProviderConfig.from_dict(raw_config)
        validate_provider(incoming)
        with self._lock:
            configs = list(self._configs)
            index = next((idx for idx, config in enumerate(configs) if config.id == incoming.id), -1)
            if index >= 0:
                configs[index] = incoming
            else:
                configs.append(incoming)
            self._validate_all(configs)
            self._configs = configs
            self._save()
            return incoming

    def delete(self, provider_id: str) -> list[ProviderConfig]:
        with self._lock:
            configs = [config for config in self._configs if config.id != provider_id]
            if len(configs) == len(self._configs):
                raise KeyError(f"unknown provider: {provider_id}")
            self._validate_all(configs)
            self._configs = configs
            self._save()
            return list(self._configs)

    def save_settings(self, raw_settings: Any) -> dict[str, Any]:
        settings = normalize_settings(raw_settings)
        with self._lock:
            self._settings = settings
            self._save()
            return dict(settings)
