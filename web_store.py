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
MAX_PROVIDERS = 100


def _validate_url(value: str, label: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an http(s) URL")


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
            repeatedly_quantified = following in "*+{"
            if repeatedly_quantified and (frame["repetition"] or frame["alternation"]):
                return True
            if frame["repetition"] or following in "*+?{":
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
    if not 0.01 <= config.recharge_ratio <= 1000:
        raise ValueError("Provider recharge_ratio must be between 0.01 and 1000")
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
    if not isinstance(rules.get("loginHints", []), list) or len(rules.get("loginHints", [])) > 20:
        raise ValueError(f"Provider {config.id} has too many login hints")
    if rules.get("readySelector") is not None and not 0 < len(str(rules["readySelector"])) <= 1000:
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
    if rules.get("afterLoadDelayMs") is not None and not 0 <= float(rules["afterLoadDelayMs"]) <= 5000:
        raise ValueError(f"Provider {config.id} afterLoadDelayMs is out of range")
    all_rules = []
    for key in ("balances", "quotas", "textMetrics"):
        items = rules.get(key, [])
        if not isinstance(items, list) or len(items) > 32:
            raise ValueError(f"Provider {config.id} {key} must contain at most 32 rules")
        all_rules.extend(items)
    if config.type == "page" and not all_rules:
        raise ValueError(f"Provider {config.id} page type requires at least one parser rule")
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
            if len(pattern) > 512 or any(character not in "imsu" for character in flags):
                raise ValueError(f"Provider {config.id} parser regex is unsupported")
            if pattern:
                if re.search(r"\\[1-9]", pattern) or _regex_has_nested_repetition(pattern):
                    raise ValueError(f"Provider {config.id} parser regex contains unsafe repetition")
                try:
                    re.compile(pattern)
                except re.error as exc:
                    raise ValueError(f"Provider {config.id} parser regex is invalid: {exc}") from exc
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
