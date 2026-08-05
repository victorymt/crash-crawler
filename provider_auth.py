"""Versioned internal authentication-session contract.

Secrets normalized here remain outside portable Provider configuration exports.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse


PROVIDER_AUTH_SESSION_SCHEMA_VERSION = 1
PROVIDER_AUTH_REFRESH_BUFFER_MS = 2 * 60 * 1000

AUTH_STATUS_MISSING = "missing"
AUTH_STATUS_AUTHENTICATED = "authenticated"
AUTH_STATUS_IDENTITY_UNBOUND = "identity_unbound"
AUTH_STATUS_EXPIRING = "expiring"
AUTH_STATUS_EXPIRED = "expired"
AUTH_STATUS_REFRESH_FAILED = "refresh_failed"
AUTH_STATUS_LOGIN_REQUIRED = "login_required"
AUTH_STATUS_ACCOUNT_MISMATCH = "account_mismatch"
AUTH_STATUS_BROWSER_UNAVAILABLE = "browser_unavailable"
AUTH_STATUS_PERMISSION_REQUIRED = "permission_required"

AUTH_SOURCE_BROWSER_TAB = "browser_tab"
AUTH_SOURCE_BROWSEROS = "browseros"
AUTH_SOURCE_LOCAL_SYNC = "local_sync"
AUTH_SOURCE_REFRESH = "refresh"
AUTH_SOURCE_SECRET = "secret"
AUTH_SOURCE_LEGACY = "legacy"
AUTH_SOURCES = {
    AUTH_SOURCE_BROWSER_TAB,
    AUTH_SOURCE_BROWSEROS,
    AUTH_SOURCE_LOCAL_SYNC,
    AUTH_SOURCE_REFRESH,
    AUTH_SOURCE_SECRET,
    AUTH_SOURCE_LEGACY,
}


class ProviderAuthSessionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _string(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def normalize_provider_auth_origin(value: Any) -> str:
    candidate = _string(value, 2048)
    if not candidate:
        return ""
    parsed = urlparse(candidate)
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return ""
    try:
        port = parsed.port
    except ValueError:
        return ""
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower()
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None and not (
        scheme == "http" and port == 80
        or scheme == "https" and port == 443
    ):
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


def _origin(value: Any) -> str:
    return normalize_provider_auth_origin(value)


def _timestamp(value: Any) -> str:
    candidate = _string(value, 128)
    if not candidate:
        return ""
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generation(value: Any) -> int:
    try:
        generation = int(value)
    except (TypeError, ValueError):
        return 0
    return generation if generation >= 0 else 0


def normalize_provider_auth_session(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    auth_token = _string(value.get("authToken"), 8192)
    refresh_token = _string(value.get("refreshToken"), 8192)
    if not auth_token and not refresh_token:
        return {}
    source = _string(value.get("source"), 64)
    return {
        "schemaVersion": PROVIDER_AUTH_SESSION_SCHEMA_VERSION,
        "providerId": _string(value.get("providerId"), 100),
        "origin": _origin(value.get("origin")),
        "userId": _string(value.get("userId"), 256),
        "username": _string(value.get("username"), 256),
        "authToken": auth_token,
        "refreshToken": refresh_token,
        "expiresAt": _string(value.get("expiresAt"), 128),
        "source": source if source in AUTH_SOURCES else "",
        "generation": _generation(value.get("generation")),
        "updatedAt": _timestamp(value.get("updatedAt")),
        "verifiedAt": _timestamp(value.get("verifiedAt")),
    }


def parse_provider_auth_session(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        decoded = {"authToken": value, "source": AUTH_SOURCE_LEGACY}
    return normalize_provider_auth_session(decoded)


def provider_auth_identity_from_value(value: Any) -> dict[str, str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {"userId": "", "username": ""}
    if not isinstance(value, dict):
        return {"userId": "", "username": ""}
    for key in ("data", "user", "account", "account_info", "accountInfo"):
        nested = value.get(key)
        if isinstance(nested, dict):
            identity = provider_auth_identity_from_value(nested)
            if identity["userId"] or identity["username"]:
                return identity

    def first(keys: tuple[str, ...]) -> str:
        for key in keys:
            candidate = _string(value.get(key), 256)
            if candidate:
                return candidate
        return ""

    return {
        "userId": first(("id", "user_id", "userId", "uuid", "sub")),
        "username": first((
            "display_name", "displayName", "username", "name", "email",
        )),
    }


def provider_auth_identity_matches(expected: Any, candidate: Any) -> bool:
    left = normalize_provider_auth_session(expected)
    right = normalize_provider_auth_session(candidate)
    if not left or not right:
        return True
    if left["userId"] and right["userId"]:
        return left["userId"] == right["userId"]
    if left["username"] and right["username"]:
        return left["username"].casefold() == right["username"].casefold()
    return True


def provider_auth_session_is_stale(current: Any, candidate: Any) -> bool:
    left = normalize_provider_auth_session(current)
    right = normalize_provider_auth_session(candidate)
    if not left or not right or not left["updatedAt"] or not right["updatedAt"]:
        return False
    left_time = datetime.fromisoformat(left["updatedAt"])
    right_time = datetime.fromisoformat(right["updatedAt"])
    if right_time != left_time:
        return right_time < left_time
    return right["generation"] < left["generation"]


def merge_provider_auth_sessions(
    previous: Any,
    incoming: Any,
    *,
    provider_id: str = "",
    origin: str = "",
    source: str = "",
    verified_at: str = "",
    now: str = "",
) -> dict[str, Any]:
    current = normalize_provider_auth_session(previous)
    candidate = normalize_provider_auth_session(incoming)
    if not candidate:
        return current
    expected_provider_id = _string(provider_id, 100)
    expected_origin = _origin(origin)
    if expected_provider_id and candidate["providerId"] and (
        candidate["providerId"] != expected_provider_id
    ):
        raise ProviderAuthSessionError(
            "provider_mismatch", "Authentication session belongs to a different Provider",
        )
    if expected_origin and candidate["origin"] and candidate["origin"] != expected_origin:
        raise ProviderAuthSessionError(
            "origin_mismatch", "Authentication session belongs to a different origin",
        )
    if current.get("providerId") and candidate["providerId"] and (
        current["providerId"] != candidate["providerId"]
    ):
        raise ProviderAuthSessionError(
            "provider_mismatch", "Authentication session belongs to a different Provider",
        )
    if current.get("origin") and candidate["origin"] and current["origin"] != candidate["origin"]:
        raise ProviderAuthSessionError(
            "origin_mismatch", "Authentication session belongs to a different origin",
        )
    if provider_auth_session_is_stale(current, candidate):
        return current
    if not provider_auth_identity_matches(current, candidate):
        raise ProviderAuthSessionError(
            AUTH_STATUS_ACCOUNT_MISMATCH,
            "Authentication session belongs to a different account",
        )

    timestamp = _timestamp(now) or _now_iso()
    merged = {
        "schemaVersion": PROVIDER_AUTH_SESSION_SCHEMA_VERSION,
        "providerId": candidate["providerId"] or expected_provider_id
        or current.get("providerId", ""),
        "origin": candidate["origin"] or expected_origin or current.get("origin", ""),
        "userId": candidate["userId"] or current.get("userId", ""),
        "username": candidate["username"] or current.get("username", ""),
        "authToken": candidate["authToken"] or current.get("authToken", ""),
        "refreshToken": candidate["refreshToken"] or current.get("refreshToken", ""),
        "expiresAt": candidate["expiresAt"] or current.get("expiresAt", ""),
        "source": candidate["source"] or (source if source in AUTH_SOURCES else "")
        or current.get("source", ""),
        "generation": candidate["generation"],
        "updatedAt": candidate["updatedAt"],
        "verifiedAt": _timestamp(verified_at) or candidate["verifiedAt"]
        or current.get("verifiedAt", ""),
    }
    materially_changed = not current or any(
        current.get(key, "") != merged[key]
        for key in (
            "providerId", "origin", "userId", "username", "authToken",
            "refreshToken", "expiresAt",
        )
    )
    current_generation = _generation(current.get("generation"))
    merged["generation"] = max(
        candidate["generation"],
        current_generation,
        current_generation + 1 if materially_changed else 0,
    )
    merged["updatedAt"] = (
        candidate["updatedAt"] or timestamp
        if materially_changed or not current.get("updatedAt")
        else current["updatedAt"]
    )
    return normalize_provider_auth_session(merged)


def bind_provider_auth_identity(
    session: Any,
    identity_value: Any,
    *,
    provider_id: str = "",
    origin: str = "",
    source: str = "",
    verified_at: str = "",
) -> dict[str, Any]:
    identity = provider_auth_identity_from_value(identity_value)
    identity_verified = bool(identity["userId"] or identity["username"])
    normalized_session = normalize_provider_auth_session(session)
    incoming = {
        **normalized_session,
        **identity,
        "verifiedAt": (
            verified_at or _now_iso()
            if identity_verified
            else normalized_session.get("verifiedAt", "")
        ),
    }
    return merge_provider_auth_sessions(
        session,
        incoming,
        provider_id=provider_id,
        origin=origin,
        source=source,
        verified_at=verified_at if identity_verified else "",
    )


def provider_auth_expires_at(value: Any) -> int | None:
    session = normalize_provider_auth_session(value)
    try:
        expires_at = int(session.get("expiresAt") or 0)
    except (TypeError, ValueError):
        return None
    return expires_at if expires_at > 0 else None


def provider_auth_status(value: Any, now_ms: int | None = None) -> str:
    session = normalize_provider_auth_session(value)
    if not session:
        return AUTH_STATUS_MISSING
    now = now_ms if now_ms is not None else int(datetime.now(timezone.utc).timestamp() * 1000)
    expires_at = provider_auth_expires_at(session)
    if expires_at is not None and expires_at <= now:
        return AUTH_STATUS_EXPIRED
    if expires_at is not None and expires_at - now <= PROVIDER_AUTH_REFRESH_BUFFER_MS:
        return AUTH_STATUS_EXPIRING
    if not session["userId"] and not session["username"]:
        return AUTH_STATUS_IDENTITY_UNBOUND
    return AUTH_STATUS_AUTHENTICATED


def public_provider_auth_state(value: Any, now_ms: int | None = None) -> dict[str, Any]:
    session = normalize_provider_auth_session(value)
    return {
        "status": provider_auth_status(session, now_ms),
        "source": session.get("source") or None,
        "identityBound": bool(session.get("userId") or session.get("username")),
        "generation": session.get("generation", 0),
        "expiresAt": provider_auth_expires_at(session),
        "verifiedAt": session.get("verifiedAt") or None,
    }
