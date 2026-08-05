"""Channel multiplier parsing and ranking shared by the local web service."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from provider_definitions import (
    PROVIDER_CAPABILITY_CHANNELS,
    provider_supports_capability,
)
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

DEFAULT_TIME_ZONE = "Asia/Shanghai"


def _api_data(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload if isinstance(payload, list) else None
    return payload.get("data", payload)


def _finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _unique_strings(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _model_name(value: Any) -> str:
    if isinstance(value, str):
        return value
    return str((value or {}).get("name") or (value or {}).get("model") or "")


def _parse_clock(value: Any) -> int | None:
    match = re.match(r"^(\d{1,2}):(\d{2})", str(value or ""))
    if not match:
        return None
    hour, minute = (int(part) for part in match.groups())
    return hour * 60 + minute if hour <= 23 and minute <= 59 else None


def is_peak_rate_active(
    group: dict[str, Any],
    now: datetime | None = None,
    time_zone: str = DEFAULT_TIME_ZONE,
) -> bool:
    if group.get("peak_rate_enabled") is not True:
        return False
    start = _parse_clock(group.get("peak_start"))
    end = _parse_clock(group.get("peak_end"))
    if start is None or end is None or start == end:
        return False
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    local = current_time.astimezone(ZoneInfo(time_zone))
    current = local.hour * 60 + local.minute
    return start <= current < end if start < end else current >= start or current < end


def _rate_value(value: Any) -> float | None:
    if isinstance(value, dict):
        for key in ("rate_multiplier", "rateMultiplier", "rate", "multiplier", "value"):
            if key in value:
                return _finite_number(value[key])
        return None
    return _finite_number(value)


def _group_rate_override(payload: Any, group_id: Any) -> float | None:
    data = _api_data(payload)
    if data is None or group_id is None:
        return None
    target = str(group_id)
    if isinstance(data, list):
        for item in data:
            item_id = (item or {}).get("group_id", (item or {}).get("groupId", (item or {}).get("id")))
            if str(item_id) == target:
                return _rate_value(item)
        return None
    if not isinstance(data, dict):
        return None
    for container in (data, data.get("rates"), data.get("groups"), data.get("items")):
        if isinstance(container, list):
            for item in container:
                item_id = (item or {}).get("group_id", (item or {}).get("groupId", (item or {}).get("id")))
                if str(item_id) == target:
                    value = _rate_value(item)
                    if value is not None:
                        return value
        elif isinstance(container, dict):
            value = _rate_value(container.get(target, container.get(group_id)))
            if value is not None:
                return value
    return None


def effective_group_rate(
    group: dict[str, Any],
    rates_payload: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    base = _finite_number(group.get("rate_multiplier", group.get("rateMultiplier")))
    user = _group_rate_override(rates_payload, group.get("id"))
    peak = _finite_number(group.get("peak_rate_multiplier", group.get("peakRateMultiplier")))
    peak_active = is_peak_rate_active(group, now)
    regular = user if user is not None else base
    effective = peak if peak_active and peak is not None else regular
    source = "peak" if peak_active and peak is not None else "user" if user is not None else "group" if base is not None else "unknown"
    return {
        "baseMultiplier": base,
        "userMultiplier": user,
        "peakMultiplier": peak,
        "peakActive": peak_active,
        "effectiveMultiplier": effective,
        "rateSource": source,
    }


def multiplier_from_name(name: Any) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:x|×|倍(?:率)?)", str(name or ""), re.I)
    return _finite_number(match.group(1)) if match else None


def _normalized_channel_name(value: Any) -> str:
    text = str(value or "").lower()
    qualifier = r"(?:\d+(?:\.\d+)?\s*(?:x|×|倍)|倍率|限时|保\s*\d*%|不稳定|稳定|缓存)"
    text = re.sub(rf"\[(?=[^\]]*{qualifier})[^\]]*\]", "", text, flags=re.I)
    text = re.sub(rf"【(?=[^】]*{qualifier})[^】]*】", "", text, flags=re.I)
    text = re.sub(rf"[（(][^）)]*{qualifier}[^）)]*[）)]", "", text, flags=re.I)
    text = re.sub(r"\d+(?:\.\d+)?\s*(?:x|×|倍(?:率)?)", "", text, flags=re.I)
    text = re.sub(r"(?:通用余额|渠道|分组|线路|channel|group)", "", text)
    text = re.sub(r"(?:openai|anthropic|grok|claude|google|azure)", "", text)
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", text)


def _group_entries(payload: Any) -> list[dict[str, Any]]:
    data = _api_data(payload)
    if isinstance(data, list) and any(isinstance(item, dict) and item.get("platform") and not item.get("platforms") for item in data):
        return [{"group": group, "categoryName": "", "platform": group.get("platform", "")} for group in data]
    nested = data.get("items") or data.get("channels") if isinstance(data, dict) else None
    categories = data if isinstance(data, list) else nested if isinstance(nested, list) else []
    entries: list[dict[str, Any]] = []
    for category in categories:
        for platform_entry in (category or {}).get("platforms", []):
            models = _unique_strings([_model_name(item) for item in platform_entry.get("supported_models", platform_entry.get("models", []))])
            for source_group in platform_entry.get("groups", []):
                group = {**source_group, "supportedModels": models}
                entries.append({
                    "group": group,
                    "categoryName": category.get("name", ""),
                    "platform": group.get("platform") or platform_entry.get("platform", ""),
                })
    return entries


def _flatten_available_groups(payload: Any, rates_payload: Any, now: datetime | None) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for entry in _group_entries(payload):
        source = entry.get("group") or {}
        models = source.get("supportedModels") or source.get("supported_models") or source.get("models") or []
        groups.append({
            **source,
            "categoryName": entry.get("categoryName", ""),
            "platform": source.get("platform") or entry.get("platform", ""),
            "supportedModels": _unique_strings([_model_name(item) for item in models]),
            "normalizedName": _normalized_channel_name(source.get("name")),
            **effective_group_rate(source, rates_payload, now),
        })
    return groups


def _monitor_items(payload: Any) -> list[dict[str, Any]]:
    data = _api_data(payload)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("items") or data.get("monitors")
        return items if isinstance(items, list) else []
    return []


def _common_name_fragment(left: str, right: str) -> bool:
    if not left or not right:
        return False
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    for size in range(min(len(shorter), 8), 3, -1):
        if any(shorter[index:index + size] in longer for index in range(len(shorter) - size + 1)):
            return True
    return False


def _choose_group(monitor: dict[str, Any], groups: list[dict[str, Any]]) -> dict[str, Any] | None:
    platform = str(monitor.get("provider") or monitor.get("platform") or "").lower()
    monitor_rate = multiplier_from_name(monitor.get("name"))
    monitor_name = _normalized_channel_name(monitor.get("name"))
    candidates = []
    explicit_ids = [monitor.get("group_id"), monitor.get("groupId"), (monitor.get("group") or {}).get("id")]
    for group in groups:
        if str(group.get("platform") or "").lower() != platform:
            continue
        group_rate = group.get("baseMultiplier")
        if group_rate is None:
            group_rate = multiplier_from_name(group.get("name"))
        same_rate = monitor_rate is not None and group_rate is not None and abs(monitor_rate - group_rate) < 1e-9
        group_name = group.get("normalizedName", "")
        same_name = bool(monitor_name and group_name and monitor_name == group_name)
        related_name = bool(monitor_name and group_name and (
            monitor_name in group_name or group_name in monitor_name or _common_name_fragment(monitor_name, group_name)
        ))
        explicit = any(value is not None and str(value) == str(group.get("id")) for value in explicit_ids)
        score = (200 if explicit else 0) + (100 if same_name else 60 if related_name else 0) + (
            30 if same_rate else -20 if monitor_rate is not None and group_rate is not None else 0
        )
        candidates.append((score, explicit, same_rate, same_name, related_name, group))
    candidates.sort(key=lambda item: item[0], reverse=True)
    if not candidates or candidates[0][0] < 40 or len(candidates) > 1 and candidates[1][0] == candidates[0][0]:
        return None
    _, explicit, same_rate, same_name, related_name, group = candidates[0]
    confidence = "explicit" if explicit else "exact" if same_rate and same_name else "high" if same_rate and related_name else "name" if same_name or related_name else "rate"
    return {**group, "matchConfidence": confidence}


def _monitor_models(monitor: dict[str, Any]) -> list[dict[str, Any]]:
    rows = [{
        "model": monitor.get("primary_model") or "",
        "status": monitor.get("primary_status") or "unknown",
        "latencyMs": _finite_number(monitor.get("primary_latency_ms")),
        "source": "primary",
    }]
    rows.extend({
        "model": _model_name(item),
        "status": item.get("status") or item.get("latest_status") or "unknown",
        "latencyMs": _finite_number(item.get("latency_ms", item.get("latest_latency_ms"))),
        "source": "extra",
    } for item in monitor.get("extra_models", []))
    return [row for row in rows if row["model"]]


def _monitor_timeline(monitor: dict[str, Any], limit: int = 30) -> list[dict[str, Any]]:
    return [{
        "status": str(item.get("status") or "unknown"),
        "latencyMs": _finite_number(item.get("latency_ms", item.get("latencyMs"))),
        "pingLatencyMs": _finite_number(item.get("ping_latency_ms", item.get("pingLatencyMs"))),
        "checkedAt": item.get("checked_at", item.get("checkedAt")),
    } for item in monitor.get("timeline", [])[:limit]]


def _config_value(config: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(config, dict) and name in config:
            return config[name]
        if hasattr(config, name):
            return getattr(config, name)
    return default


def _with_recharge_ratio(channel: dict[str, Any], config: Any) -> dict[str, Any]:
    ratio = _finite_number(_config_value(config, "rechargeRatio", "recharge_ratio", default=1)) or 1
    result = {**channel, "rechargeRatio": ratio}
    for name in ("baseMultiplier", "userMultiplier", "peakMultiplier", "effectiveMultiplier"):
        value = channel.get(name)
        result[f"listed{name[0].upper()}{name[1:]}"] = value
        result[name] = round(value / ratio, 8) if value is not None else None
    return result


def parse_sub2api_channels(
    config: Any,
    monitors_payload: Any,
    available_payload: Any,
    rates_payload: Any = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    groups = _flatten_available_groups(available_payload, rates_payload, now)
    target_url = _config_value(config, "targetUrl", "target_url", default="")
    monitor_url = urljoin(str(target_url), "/monitor") if target_url else ""
    channels = []
    for monitor in _monitor_items(monitors_payload):
        group = _choose_group(monitor, groups)
        observed = _monitor_models(monitor)
        name_rate = multiplier_from_name(monitor.get("name"))
        models = _unique_strings(group.get("supportedModels", []) if group and group.get("supportedModels") else [item["model"] for item in observed])
        timeline = _monitor_timeline(monitor)
        channel = {
            "providerId": _config_value(config, "id", default=""),
            "providerName": _config_value(config, "name", default=""),
            "monitorId": monitor.get("id"),
            "groupId": group.get("id") if group else None,
            "name": monitor.get("name") or (group or {}).get("name") or "Unnamed channel",
            "groupName": (group or {}).get("name") or monitor.get("group_name") or "",
            "categoryName": (group or {}).get("categoryName") or "",
            "platform": monitor.get("provider") or monitor.get("platform") or (group or {}).get("platform") or "",
            "models": models,
            "observedModels": observed,
            "primaryModel": monitor.get("primary_model") or (observed[0]["model"] if observed else ""),
            "status": monitor.get("primary_status") or "unknown",
            "latencyMs": _finite_number(monitor.get("primary_latency_ms")),
            "pingLatencyMs": _finite_number(monitor.get("primary_ping_latency_ms")),
            "availability7d": _finite_number(monitor.get("availability_7d")),
            "checkedAt": timeline[0].get("checkedAt") if timeline else None,
            "timeline": timeline,
            "baseMultiplier": (group or {}).get("baseMultiplier", name_rate),
            "userMultiplier": (group or {}).get("userMultiplier"),
            "peakMultiplier": (group or {}).get("peakMultiplier"),
            "peakActive": (group or {}).get("peakActive", False),
            "effectiveMultiplier": (group or {}).get("effectiveMultiplier", name_rate),
            "rateSource": (group or {}).get("rateSource") or ("monitor-name" if name_rate is not None else "unknown"),
            "matchConfidence": (group or {}).get("matchConfidence", "monitor-name"),
            "monitorUrl": monitor_url,
        }
        channels.append(_with_recharge_ratio(channel, config))
    return channels


def parse_ezaiclub_channels(config: Any, monitors_payload: Any, groups_payload: Any, rates_payload: Any = None) -> list[dict[str, Any]]:
    return parse_sub2api_channels(config, monitors_payload, groups_payload, rates_payload)


def channel_status_for_model(channel: dict[str, Any], selected_model: str = "") -> dict[str, Any] | None:
    if selected_model and selected_model not in channel.get("models", []):
        return None
    observed = next((item for item in channel.get("observedModels", []) if item.get("model") == selected_model), None)
    if observed:
        return {"status": observed.get("status") or "unknown", "latencyMs": observed.get("latencyMs"), "statusSource": "model"}
    return {
        "status": channel.get("status") or "unknown",
        "latencyMs": channel.get("latencyMs"),
        "statusSource": "channel" if selected_model else "primary",
    }


def available_channel_models(snapshots: list[dict[str, Any]]) -> list[str]:
    return sorted(_unique_strings([
        model
        for snapshot in snapshots
        for channel in snapshot.get("channels", []) or []
        for model in channel.get("models", [])
    ]))


def available_channel_providers(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    providers: dict[str, dict[str, Any]] = {}
    for snapshot in snapshots:
        if not provider_supports_capability(
            str(snapshot.get("type") or ""), PROVIDER_CAPABILITY_CHANNELS
        ):
            continue
        channels = snapshot.get("channels", []) or []
        provider_id = str(snapshot.get("id") or "")
        if not provider_id:
            continue
        first_channel = channels[0] if channels else {}
        providers[provider_id] = {
            "id": provider_id,
            "name": str(snapshot.get("name") or first_channel.get("providerName") or provider_id),
            "url": str(snapshot.get("url") or ""),
            "status": str(snapshot.get("status") or "unknown"),
            "error": str(snapshot.get("error") or snapshot.get("channelError") or ""),
            "channelCount": len(channels),
            "channelCheckedAt": snapshot.get("channelCheckedAt"),
            "channelsStale": snapshot.get("channelsStale") is True,
        }
    return sorted(providers.values(), key=lambda item: item["name"])


def list_channels(
    snapshots: list[dict[str, Any]],
    selected_model: str = "",
    statuses: tuple[str, ...] | list[str] | None = None,
    rate_mode: str = "all",
    provider_id: str = "",
    availability_only: bool = False,
) -> list[dict[str, Any]]:
    allowed = set(statuses) if statuses is not None else None
    status_ranks = {"operational": 0, "degraded": 1, "error": 2, "unknown": 3}
    result = []
    for snapshot in snapshots:
        balance_available = _provider_balance_allows_use(snapshot)
        for channel in snapshot.get("channels", []) or []:
            resolved = channel_status_for_model(channel, selected_model)
            if not resolved or allowed is not None and resolved.get("status") not in allowed:
                continue
            if provider_id and str(channel.get("providerId") or snapshot.get("id")) != str(provider_id):
                continue
            effective_multiplier = _finite_number(channel.get("effectiveMultiplier"))
            has_rate = effective_multiplier is not None
            if rate_mode == "known" and not has_rate or rate_mode == "unknown" and has_rate:
                continue
            if availability_only and (
                snapshot.get("status") != "ok"
                or snapshot.get("channelsStale") is True
                or not balance_available
                or resolved.get("status") != "operational"
                or not has_rate
            ):
                continue
            status = resolved.get("status") or "unknown"
            result.append({
                **channel,
                "effectiveMultiplier": effective_multiplier,
                "selectedModel": selected_model or channel.get("primaryModel", ""),
                "resolvedStatus": status,
                "resolvedLatencyMs": resolved.get("latencyMs"),
                "statusSource": resolved.get("statusSource"),
                "providerStatus": snapshot.get("status") or "unknown",
                "balanceAvailable": balance_available,
                "channelsStale": snapshot.get("channelsStale") is True,
                "statusRank": status_ranks.get(status, 3),
            })
    result.sort(key=lambda channel: (
        _finite_number(channel.get("effectiveMultiplier")) is None,
        _finite_number(channel.get("effectiveMultiplier")) if _finite_number(channel.get("effectiveMultiplier")) is not None else math.inf,
        channel.get("statusRank", 3),
        -(channel.get("availability7d") if channel.get("availability7d") is not None else -1),
        channel.get("resolvedLatencyMs") if channel.get("resolvedLatencyMs") is not None else math.inf,
        channel.get("providerName", ""),
        channel.get("name", ""),
    ))
    return result


def summarize_channel_refresh(snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    channel_snapshots = [
        snapshot for snapshot in snapshots
        if provider_supports_capability(
            str(snapshot.get("type") or ""), PROVIDER_CAPABILITY_CHANNELS
        )
    ]
    timestamps = [
        str(snapshot.get("channelCheckedAt"))
        for snapshot in channel_snapshots
        if snapshot.get("channelCheckedAt")
    ]
    return {
        "providerCount": len(channel_snapshots),
        "channelCount": sum(len(snapshot.get("channels", []) or []) for snapshot in channel_snapshots),
        "unrankedCount": sum(
            sum(
                _finite_number(channel.get("effectiveMultiplier")) is None
                for channel in snapshot.get("channels", []) or []
            )
            for snapshot in channel_snapshots
        ),
        "failedCount": sum(bool(
            snapshot.get("channelError")
            or snapshot.get("channelsStale") is True
            or snapshot.get("status") in {"error", "stale", "needs_login", "needs_visit"}
        ) for snapshot in channel_snapshots),
        "latestCheckedAt": max(timestamps, default=None),
    }


def _provider_balance_allows_use(snapshot: dict[str, Any]) -> bool:
    values = [
        _finite_number(item.get("value"))
        for item in snapshot.get("balances", [])
        if item.get("key") in {"balance", "total_balance"}
    ]
    numeric = [value for value in values if value is not None]
    return not numeric or max(numeric) > 0


def rank_available_channels(
    snapshots: list[dict[str, Any]],
    selected_model: str = "",
    statuses: tuple[str, ...] | list[str] = ("operational",),
) -> list[dict[str, Any]]:
    result = [
        channel for channel in list_channels(
            snapshots,
            selected_model,
            statuses=statuses,
            rate_mode="known",
        )
        if channel.get("providerStatus") == "ok"
        and channel.get("channelsStale") is not True
        and channel.get("balanceAvailable")
    ]
    result.sort(key=lambda channel: (
        channel.get("effectiveMultiplier", math.inf),
        channel.get("statusSource") != "model",
        -(channel.get("availability7d") if channel.get("availability7d") is not None else -1),
        channel.get("resolvedLatencyMs") if channel.get("resolvedLatencyMs") is not None else math.inf,
        channel.get("providerName", ""),
        channel.get("name", ""),
    ))
    return result
