#!/usr/bin/env python3
"""Provider collectors for local quota/usage dashboard."""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http.cookiejar import Cookie, CookieJar
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterator
from urllib.error import HTTPError
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

from channels import parse_ezaiclub_channels, parse_sub2api_channels

BROWSEROS_BIN = os.environ.get("BROWSEROS_BIN", "/usr/bin/browseros")
DEFAULT_PROFILE_DIR = os.environ.get(
    "BROWSEROS_PROFILE_DIR", str(Path.home() / ".browseros-crawler-profile")
)
BROWSEROS_SOURCE_PROFILE_DIR = os.environ.get(
    "BROWSEROS_SOURCE_PROFILE_DIR", str(Path.home() / ".config" / "browser-os")
)
DEFAULT_OPENCODE_URL = (
    "https://opencode.ai/workspace/wrk_01KW9MTABWQ0DNJ014CV528WC2/go"
)
DEFAULT_DEEPSEEK_URL = "https://platform.deepseek.com/usage"
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
DEFAULT_EZAICLUB_DASHBOARD_URL = "https://www.ezaiclub.com/dashboard"
DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL = "https://www.ezaiclub.com/subscriptions"
DEFAULT_SILICONFLOW_COUPON_URL = "https://cloud.siliconflow.cn/me/expensebill?tab=coupon"

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.environ.get("PROVIDER_CONFIG", ROOT / "providers.local.json"))
CACHE_FILE = Path(os.environ.get("PROVIDER_CACHE", ROOT / ".provider-cache.json"))
SECRET_FILE = Path(os.environ.get("PROVIDER_SECRETS", ROOT / ".provider-secrets.json"))
DEFAULT_DUMP_DIR = Path(os.environ.get("PROVIDER_DUMP_DIR", ROOT / "dumps"))

REQUEST_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
}

USAGE_HINTS = re.compile(
    r"usage|quota|reset|额度|用量|重置|credits?|remaining|limit|plan|subscription|"
    r"invoice|balance|coupon|voucher|余额|消耗|充值|模型|账单|费用|赠金|优惠券|代金券|券",
    re.I,
)
OPENCODE_LOGIN_HINTS = (
    "/github/authorize",
    "/google/authorize",
    "Continue with GitHub",
    "Continue with Google",
)
DEEPSEEK_LOGIN_HINTS = (
    "Log in",
    "Sign up",
    "Forgot password?",
    "Log in with Google",
    "登录",
    "注册",
)
EZAICLUB_LOGIN_HINTS = (
    "Login - EZAIClub",
    "Login",
    "Sign in",
    "Sign up",
    "登录",
)
NEWAPI_LOGIN_HINTS = (
    "login",
    "sign in",
    "登录",
    "注册",
)
SUB2API_LOGIN_HINTS = NEWAPI_LOGIN_HINTS
SILICONFLOW_LOGIN_HINTS = (
    "account.siliconflow.cn/login",
    "硅基流动统一登录",
    "Accelerate AGI to Benefit Humanity",
    "Blazing-fast, cost-effective Generative AI cloud services",
    "SiliconFlow Ambassador Program",
)
OPENCODE_USAGE_TYPES = ("滚动用量", "每周用量", "每月用量")

DEFAULT_READY_PATTERN = re.compile(
    r"余额|可用|剩余|赠金|充值|券|优惠券|代金券|账单|费用|消费|有效|到期|"
    r"用量|额度|重置|订阅|套餐|滚动用量|每周用量|每月用量|"
    r"balance|coupon|credit|amount|expense|bill|valid|expires|usage|quota|plan|subscription",
    re.I,
)
OPENCODE_READY_PATTERN = re.compile(r"滚动用量|每周用量|每月用量|重置于|订阅|balance|Balance|余额", re.I)
EZAICLUB_BALANCE_READY_PATTERN = re.compile(
    r"账户余额|可用余额|余额|充值|balance|wallet|credit|[$¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:USD|CNY|RMB|元)",
    re.I,
)
EZAICLUB_SUBSCRIPTION_READY_PATTERN = re.compile(
    r"当前套餐|套餐名称|订阅状态|订阅用量|到期时间|有效期|续费时间|已达到|"
    r"Pro|Monthly|Plan|Subscription|expires|planName|weekly_usage|monthly_usage|"
    r"[$¥￥]\s*\d+(?:\.\d+)?\s*/\s*[$¥￥]?\s*\d+",
    re.I,
)
SILICONFLOW_READY_PATTERN = re.compile(
    r"余额|可用|剩余|赠金|充值|券|优惠券|代金券|账单|费用|消费|有效|到期|"
    r"balance|coupon|credit|amount|expense|bill|valid|expires",
    re.I,
)
PROFILE_SYNC_IGNORE = (
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "Service Worker",
    "blob_storage",
    "Crashpad",
    "*.log",
)
PROFILE_SYNC_MARKER = ".provider-sync-meta.json"
SECRET_LOCK = threading.RLock()


class ProviderError(RuntimeError):
    pass


class NotLoggedInError(ProviderError):
    pass


class MissingCookieError(ProviderError):
    pass


class ParserNeedsFixtureError(ProviderError):
    pass


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)


@dataclass(frozen=True)
class ProviderConfig:
    id: str
    name: str
    type: str
    target_url: str
    enabled: bool = True
    profile_dir: str = DEFAULT_PROFILE_DIR
    cookie_cache: str | None = None
    api_key_env: str | None = None
    secondary_urls: list[dict[str, str]] | None = None
    mode: str = "browser"
    group: str = ""
    recharge_ratio: float = 1.0
    parser_rules: dict[str, Any] | None = None
    quota_per_unit: float = 500000.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProviderConfig":
        if not isinstance(data, dict):
            raise ValueError("Provider config must be an object")
        provider_id = str(data.get("id") or "").strip()
        provider_type = str(data.get("type") or "").strip()
        target_url = str(data.get("target_url") or data.get("targetUrl") or "").strip()
        if not provider_id:
            raise ValueError("Provider id is required")
        if not provider_type:
            raise ValueError(f"Provider {provider_id} type is required")
        if not target_url:
            raise ValueError(f"Provider {provider_id} target URL is required")
        profile_dir = str(data.get("profile_dir") or DEFAULT_PROFILE_DIR)
        cookie_cache = data.get("cookie_cache", data.get("cookieCache"))
        secondary_urls = []
        raw_secondary_urls = data.get("secondary_urls", data.get("secondaryUrls", []))
        if not isinstance(raw_secondary_urls, list):
            raise ValueError(f"Provider {provider_id} secondary URLs must be an array")
        for index, item in enumerate(raw_secondary_urls):
            if isinstance(item, str):
                secondary_urls.append({"id": f"page-{index + 1}", "label": "打开详情页", "url": item})
            elif isinstance(item, dict) and item.get("url"):
                secondary_urls.append(
                    {
                        "id": str(item.get("id") or f"page-{index + 1}"),
                        "label": str(item.get("label") or "打开详情页"),
                        "url": str(item["url"]),
                    }
                )
        return cls(
            id=provider_id,
            name=str(data.get("name") or provider_id),
            type=provider_type,
            target_url=target_url,
            enabled=bool(data.get("enabled", True)),
            profile_dir=os.path.expanduser(profile_dir),
            cookie_cache=os.path.expanduser(str(cookie_cache)) if cookie_cache else None,
            api_key_env=str(data.get("api_key_env", data.get("apiKeyEnv"))) if data.get("api_key_env", data.get("apiKeyEnv")) else None,
            secondary_urls=secondary_urls,
            mode=str(data.get("mode") or "browser"),
            group=str(data.get("group") or "").strip(),
            recharge_ratio=float(data.get("recharge_ratio", data.get("rechargeRatio", 1)) or 1),
            parser_rules=data.get("parser_rules", data.get("parserRules")) if isinstance(
                data.get("parser_rules", data.get("parserRules")), dict
            ) else None,
            quota_per_unit=float(data.get("quota_per_unit", data.get("quotaPerUnit", 500000)) or 500000),
        )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "target_url": self.target_url,
            "enabled": self.enabled,
            "profile_dir": self.profile_dir,
            "mode": self.mode,
            "group": self.group,
            "recharge_ratio": self.recharge_ratio,
        }
        if self.cookie_cache:
            data["cookie_cache"] = self.cookie_cache
        if self.api_key_env:
            data["api_key_env"] = self.api_key_env
        if self.secondary_urls:
            data["secondary_urls"] = self.secondary_urls
        if self.parser_rules:
            data["parser_rules"] = self.parser_rules
        if self.type == "newapi" or self.quota_per_unit != 500000:
            data["quota_per_unit"] = self.quota_per_unit
        return data


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def default_cookie_cache(provider_id: str) -> str:
    env_name = f"{provider_id.upper().replace('-', '_')}_COOKIE_CACHE"
    if os.environ.get(env_name):
        return os.environ[env_name]
    if provider_id == "opencode-go" and os.environ.get("OPENCODE_COOKIE_CACHE"):
        return os.environ["OPENCODE_COOKIE_CACHE"]
    return str(
        Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        / "provider-dashboard"
        / provider_id
        / "cookies.json"
    )


def default_config() -> dict[str, Any]:
    return {
        "providers": [
            {
                "id": "opencode-go",
                "name": "OpenCode Go",
                "type": "opencode",
                "target_url": DEFAULT_OPENCODE_URL,
                "enabled": True,
                "profile_dir": DEFAULT_PROFILE_DIR,
                "cookie_cache": default_cookie_cache("opencode-go"),
                "mode": "http_then_browser",
                "group": "",
                "recharge_ratio": 1,
            },
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "type": "deepseek",
                "target_url": DEFAULT_DEEPSEEK_URL,
                "enabled": True,
                "profile_dir": DEFAULT_PROFILE_DIR,
                "cookie_cache": default_cookie_cache("deepseek"),
                "api_key_env": "DEEPSEEK_API_KEY",
                "mode": "api",
                "group": "",
                "recharge_ratio": 1,
            },
            {
                "id": "ezaiclub",
                "name": "EZAICLUB",
                "type": "ezaiclub",
                "target_url": DEFAULT_EZAICLUB_DASHBOARD_URL,
                "enabled": True,
                "profile_dir": DEFAULT_PROFILE_DIR,
                "cookie_cache": default_cookie_cache("ezaiclub"),
                "secondary_urls": [
                    {
                        "label": "打开订阅页",
                        "url": DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL,
                    }
                ],
                "mode": "browser",
                "group": "",
                "recharge_ratio": 10,
            },
            {
                "id": "siliconflow",
                "name": "SiliconFlow",
                "type": "siliconflow",
                "target_url": DEFAULT_SILICONFLOW_COUPON_URL,
                "enabled": True,
                "profile_dir": DEFAULT_PROFILE_DIR,
                "cookie_cache": default_cookie_cache("siliconflow"),
                "mode": "browser",
                "group": "",
                "recharge_ratio": 1,
            },
        ]
    }


def load_config(path: Path = CONFIG_FILE) -> list[ProviderConfig]:
    data = default_config()
    if path.exists():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict) or not isinstance(loaded.get("providers"), list):
            raise ValueError(f"invalid provider config: {path}")
        data = loaded
    return [ProviderConfig.from_dict(item) for item in data["providers"]]


def load_local_secret(name: str, path: Path = SECRET_FILE) -> str:
    with SECRET_LOCK:
        if not path.exists():
            return ""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        return str(data.get(name) or "") if isinstance(data, dict) else ""


def set_local_secret(name: str, value: str, path: Path = SECRET_FILE) -> None:
    with SECRET_LOCK:
        data: dict[str, str] = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = {str(key): str(item) for key, item in loaded.items() if item}
            except (OSError, json.JSONDecodeError):
                data = {}
        normalized = str(value or "").strip()
        if normalized:
            data[name] = normalized
        else:
            data.pop(name, None)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)


def delete_local_secret(name: str, path: Path = SECRET_FILE) -> None:
    set_local_secret(name, "", path)


def build_browser(profile_dir: str):
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as exc:
        raise ProviderError(
            "Playwright is not installed in the project virtual environment. "
            "Create `.venv`, run `UV_CACHE_DIR=/tmp/uv-cache uv pip install -r requirements.txt`, "
            "then start the service with `uv run python server.py 19765`."
        ) from exc

    profile_path = Path(profile_dir).expanduser()
    remove_profile_singletons(profile_path)

    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        str(profile_path),
        executable_path=BROWSEROS_BIN,
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    return pw, context


def remove_profile_singletons(profile_dir: Path) -> None:
    for name in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
        path = profile_dir / name
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def profile_fingerprint(source: Path) -> dict[str, Any]:
    """Cheap change detector for BrowserOS profile sync."""
    candidates = [
        source / "Cookies",
        source / "Default" / "Cookies",
        source / "Default" / "Network" / "Cookies",
        source / "Local State",
        source / "Default" / "Preferences",
    ]
    files = []
    for path in candidates:
        if not path.is_file():
            continue
        stat = path.stat()
        files.append({"path": str(path.relative_to(source)), "mtime_ns": stat.st_mtime_ns, "size": stat.st_size})
    if not files:
        # Fall back to directory mtime when cookie files are not present.
        stat = source.stat()
        files.append({"path": ".", "mtime_ns": stat.st_mtime_ns, "size": 0})
    return {"source": str(source.resolve()), "files": files}


def sync_browseros_profile(
    source_dir: str | Path = BROWSEROS_SOURCE_PROFILE_DIR,
    target_dir: str | Path = DEFAULT_PROFILE_DIR,
    force: bool = False,
) -> dict[str, Any]:
    source = Path(source_dir).expanduser()
    target = Path(target_dir).expanduser()
    if not source.exists() or not source.is_dir():
        raise ProviderError(f"BrowserOS source profile not found: {source}")
    if source.resolve() == target.resolve():
        raise ProviderError("BrowserOS source and target profiles must be different")

    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    fingerprint = profile_fingerprint(source)
    marker = target / PROFILE_SYNC_MARKER
    if not force and marker.is_file():
        try:
            previous = json.loads(marker.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = None
        if previous and previous.get("fingerprint") == fingerprint:
            remove_profile_singletons(target)
            return {
                "ok": True,
                "skipped": True,
                "source": str(source),
                "target": str(target),
                "synced_at": previous.get("synced_at") or now_iso(),
            }

    remove_profile_singletons(target)
    shutil.copytree(
        source,
        target,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns(*PROFILE_SYNC_IGNORE),
    )
    remove_profile_singletons(target)
    synced_at = now_iso()
    marker.write_text(
        json.dumps({"fingerprint": fingerprint, "synced_at": synced_at}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "ok": True,
        "skipped": False,
        "source": str(source),
        "target": str(target),
        "synced_at": synced_at,
    }


def wait_for_page_ready(
    page,
    ready_pattern: re.Pattern[str] | None = DEFAULT_READY_PATTERN,
    timeout_ms: int = 18000,
    min_wait_ms: int = 1200,
    stable_samples: int = 3,
    poll_ms: int = 400,
) -> str:
    """Wait until page text looks ready or stabilizes, instead of fixed sleeps."""
    started = time.monotonic()
    deadline = started + timeout_ms / 1000.0
    last_text = ""
    stable_count = 0
    body_text = ""

    try:
        page.wait_for_load_state("domcontentloaded", timeout=min(timeout_ms, 60000))
    except Exception:
        pass

    while time.monotonic() < deadline:
        try:
            body_text = page.inner_text("body")
        except Exception:
            page.wait_for_timeout(poll_ms)
            continue

        elapsed_ms = (time.monotonic() - started) * 1000.0
        waited_enough = elapsed_ms >= min_wait_ms
        ready = bool(ready_pattern.search(body_text)) if ready_pattern is not None else True

        if body_text and body_text == last_text:
            stable_count += 1
        else:
            stable_count = 0
            last_text = body_text

        if waited_enough and ready:
            return body_text
        if waited_enough and stable_count >= stable_samples and body_text.strip():
            return body_text
        page.wait_for_timeout(poll_ms)

    try:
        return page.inner_text("body")
    except Exception:
        return body_text


class BrowserSession:
    """Reusable Playwright persistent context for one profile directory."""

    def __init__(self, profile_dir: str) -> None:
        self.profile_dir = profile_dir
        self._pw = None
        self._context = None

    def start(self) -> "BrowserSession":
        if self._context is None:
            self._pw, self._context = build_browser(self.profile_dir)
        return self

    def close(self) -> None:
        if self._context is not None:
            try:
                self._context.close()
            finally:
                self._context = None
        if self._pw is not None:
            try:
                self._pw.stop()
            finally:
                self._pw = None

    def __enter__(self) -> "BrowserSession":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    @property
    def context(self):
        if self._context is None:
            self.start()
        return self._context

    def page(self):
        context = self.context
        return context.pages[0] if context.pages else context.new_page()

    def cookies(self, urls: str | list[str] | None = None) -> list[dict[str, Any]]:
        if urls is None:
            return self.context.cookies()
        if isinstance(urls, str):
            return self.context.cookies(urls)
        return self.context.cookies(urls)


def html_tokens(html: str) -> list[str]:
    parser = TextExtractor()
    parser.feed(html)
    return parser.parts


def page_tokens(page) -> list[str]:
    return [line.strip() for line in page.inner_text("body").splitlines() if line.strip()]


def is_login_html(url: str, html: str, hints: tuple[str, ...]) -> bool:
    return any(hint in url or hint in html for hint in hints)


def cookie_applies(cookie: dict[str, Any], host: str) -> bool:
    domain = str(cookie.get("domain") or host).lstrip(".")
    return host == domain or host.endswith("." + domain)


def cookie_payload(cookies: list[dict[str, Any]], host: str) -> list[dict[str, Any]]:
    payload = []
    for cookie in cookies:
        if not cookie_applies(cookie, host):
            continue
        payload.append(
            {
                "name": cookie["name"],
                "value": cookie["value"],
                "domain": cookie.get("domain") or host,
                "path": cookie.get("path") or "/",
                "expires": cookie.get("expires"),
                "secure": bool(cookie.get("secure")),
            }
        )
    return payload


def load_cookie_cache(path: str) -> list[dict[str, Any]]:
    cookie_path = Path(path)
    if not cookie_path.exists():
        raise MissingCookieError(f"cookie cache not found: {cookie_path}")
    data = json.loads(cookie_path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise MissingCookieError(f"cookie cache is empty: {cookie_path}")
    return data


def save_cookie_cache(path: str, cookies: list[dict[str, Any]], host: str) -> list[dict[str, Any]]:
    payload = cookie_payload(cookies, host)
    if not payload:
        raise NotLoggedInError(f"browser profile did not expose cookies for {host}")

    cookie_path = Path(path)
    cookie_path.parent.mkdir(parents=True, exist_ok=True)
    cookie_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        cookie_path.chmod(0o600)
    except OSError:
        pass
    return payload


def make_cookie(cookie: dict[str, Any], host: str) -> Cookie:
    domain = cookie.get("domain") or host
    path = cookie.get("path") or "/"
    return Cookie(
        version=0,
        name=cookie["name"],
        value=cookie["value"],
        port=None,
        port_specified=False,
        domain=domain,
        domain_specified=True,
        domain_initial_dot=str(domain).startswith("."),
        path=path,
        path_specified=True,
        secure=bool(cookie.get("secure")),
        expires=None,
        discard=False,
        comment=None,
        comment_url=None,
        rest={},
        rfc2109=False,
    )


def request_html(url: str, cookies: list[dict[str, Any]], login_hints: tuple[str, ...]) -> tuple[str, str]:
    host = urlparse(url).hostname or ""
    jar = CookieJar()
    for cookie in cookies:
        if cookie_applies(cookie, host):
            jar.set_cookie(make_cookie(cookie, host))

    opener = build_opener(HTTPCookieProcessor(jar))
    request = Request(url, headers=REQUEST_HEADERS)
    response = opener.open(request, timeout=20)
    charset = response.headers.get_content_charset() or "utf-8"
    html = response.read().decode(charset, "replace")
    final_url = response.geturl()
    if is_login_html(final_url, html, login_hints):
        raise NotLoggedInError("cached cookies are expired or invalid")
    return html, final_url


def next_non_usage_token(tokens: list[str], start: int) -> tuple[str | None, int]:
    for idx in range(start, len(tokens)):
        token = tokens[idx].strip()
        if token and token not in OPENCODE_USAGE_TYPES:
            return token, idx
    return None, start


def parse_percent(value: str | None) -> int | None:
    if not value:
        return None
    match = re.fullmatch(r"\s*(\d+)\s*%\s*", value)
    if not match:
        return None
    return int(match.group(1))


def balance_metric(
    key: str,
    label: str,
    value: str | int | float | None,
    currency: str | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "value": "" if value is None else str(value),
        "currency": currency,
    }


def normalize_amount(value: str) -> str:
    try:
        return f"{float(value):.2f}"
    except ValueError:
        return value


def text_metric(key: str, label: str, value: str | None) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "value": value or "",
        "unit": None,
        "percent": None,
        "reset_in": None,
    }


def _rule_regex(rule: dict[str, Any], pattern_key: str = "pattern", flags_key: str = "flags") -> re.Pattern[str] | None:
    pattern = str(rule.get(pattern_key) or "")
    if not pattern:
        return None
    flag_value = str(rule.get(flags_key) or "")
    flags = 0
    for character, option in (("i", re.I), ("m", re.M), ("s", re.S)):
        if character in flag_value:
            flags |= option
    return re.compile(pattern, flags)


def _match_group(match: re.Match[str] | None, index: Any, default: int = 1) -> str:
    if match is None:
        return ""
    try:
        value = match.group(int(index if index is not None else default))
    except (IndexError, TypeError, ValueError):
        return ""
    return str(value or "").strip()


def _numeric_values(value: Any) -> list[str]:
    return [match.replace(",", "") for match in re.findall(r"-?\d+(?:[.,]\d+)?", str(value or ""))]


def _selector_value(value: Any, rule: dict[str, Any], group: Any = 1, fallback_text: bool = False) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    pattern = _rule_regex(rule)
    if pattern:
        match = pattern.search(text)
        return _match_group(match, group) or (_numeric_values(match.group(0))[0] if match and _numeric_values(match.group(0)) else "")
    if fallback_text:
        return text
    numbers = _numeric_values(text)
    return numbers[0] if numbers else ""


def _format_currency_amount(value: Any, currency: Any = None, symbol: Any = "") -> str:
    amount = normalize_amount(str(value))
    if symbol:
        return f"{symbol}{amount}"
    if currency == "USD":
        return f"${amount}"
    if currency == "CNY":
        return f"¥{amount}"
    return f"{amount} {currency}" if currency else amount


def _format_quota_value(used: Any, limit: Any, currency: Any = None, symbol: Any = "") -> str:
    effective_symbol = symbol or ("$" if not currency else "")
    return (
        f"{_format_currency_amount(used, currency, effective_symbol)} / "
        f"{_format_currency_amount(limit, currency, effective_symbol)}"
    )


def parse_generic_page_tokens(tokens: list[str], parser_rules: dict[str, Any]) -> dict[str, Any]:
    balances: list[dict[str, Any]] = []
    usage: list[dict[str, Any]] = []
    text_metrics: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    def matches(rule: dict[str, Any]) -> Iterator[tuple[re.Match[str], int]]:
        pattern = _rule_regex(rule)
        if pattern:
            for index, token in enumerate(tokens):
                match = pattern.search(str(token or "").strip())
                if match:
                    yield match, index

    for rule in parser_rules.get("balances", []):
        if rule.get("selector"):
            continue
        for match, _ in matches(rule):
            label = str(rule.get("label") or _match_group(match, rule.get("labelGroup")) or "余额")
            amount = _match_group(match, rule.get("valueGroup"), 1)
            key = ("balance", label, amount)
            if not amount or key in seen:
                continue
            seen.add(key)
            balances.append(balance_metric(str(rule.get("key") or rule.get("id") or "balance"), label, normalize_amount(amount), rule.get("currency")))
            if rule.get("limit") and len(balances) >= int(rule["limit"]):
                break

    for rule in parser_rules.get("quotas", []):
        if rule.get("selector") or rule.get("usedSelector") or rule.get("limitSelector"):
            continue
        for match, token_index in matches(rule):
            used_raw = _match_group(match, rule.get("usedGroup"), 1)
            limit_raw = _match_group(match, rule.get("limitGroup"), 2)
            try:
                used, limit = float(used_raw), float(limit_raw)
            except ValueError:
                continue
            if limit <= 0:
                continue
            label = str(rule.get("label") or _match_group(match, rule.get("labelGroup")) or "用量")
            value = _format_quota_value(used_raw, limit_raw, rule.get("currency"), rule.get("symbol"))
            key = ("usage", label, value)
            if key in seen:
                continue
            seen.add(key)
            reset_in = None
            reset_pattern = _rule_regex(rule, "resetPattern", "resetFlags")
            if reset_pattern:
                lookahead = int(rule.get("resetLookahead") or 6)
                for token in tokens[token_index:token_index + lookahead] + tokens:
                    reset_match = reset_pattern.search(token)
                    if reset_match:
                        reset_in = _match_group(reset_match, rule.get("resetGroup"), 1)
                        break
            usage.append(usage_metric(str(rule.get("key") or rule.get("id") or "usage"), label, round(used / limit * 100), value, reset_in))
            if rule.get("limit") and len(usage) >= int(rule["limit"]):
                break

    for rule in parser_rules.get("textMetrics", []):
        if rule.get("selector"):
            continue
        for match, _ in matches(rule):
            value = str(rule.get("staticValue")) if rule.get("staticValue") is not None else _match_group(match, rule.get("valueGroup"), 1)
            label = str(rule.get("label") or _match_group(match, rule.get("labelGroup")) or "指标")
            key = ("text", label, value)
            if not value or key in seen:
                continue
            seen.add(key)
            text_metrics.append(text_metric(str(rule.get("key") or rule.get("id") or f"metric_{len(text_metrics) + 1}"), label, value))
            if rule.get("limit") and len(text_metrics) >= int(rule["limit"]):
                break

    return {"balances": balances, "usage": usage, "textMetrics": text_metrics, "metrics": balances + usage + text_metrics}


def parse_generic_selector_results(selector_results: dict[str, Any], parser_rules: dict[str, Any]) -> dict[str, Any]:
    balances: list[dict[str, Any]] = []
    usage: list[dict[str, Any]] = []
    text_metrics: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []

    def first(values: Any) -> str:
        return next((str(value).strip() for value in values or [] if str(value).strip()), "")

    def diagnostic(rule: dict[str, Any], result: dict[str, Any], status: str, error: str | None = None) -> None:
        diagnostics.append({
            "ruleId": rule.get("id"),
            "label": rule.get("label") or rule.get("id"),
            "pageId": rule.get("pageId") or "main",
            "status": status,
            "matchCount": result.get("matchCount", 0),
            "samples": (result.get("values") or [])[:3],
            "error": error,
        })

    for rule in parser_rules.get("balances", []):
        if not rule.get("selector"):
            continue
        result = selector_results.get(rule.get("id"), {})
        amount = _selector_value(first(result.get("values")), rule, rule.get("valueGroup", 1))
        if not amount:
            diagnostic(rule, result, "not_found")
            continue
        balances.append(balance_metric(str(rule.get("key") or rule.get("id") or "balance"), str(rule.get("label") or "余额"), normalize_amount(amount), rule.get("currency")))
        diagnostic(rule, result, "matched")

    for rule in parser_rules.get("quotas", []):
        if not (rule.get("selector") or rule.get("usedSelector") or rule.get("limitSelector")):
            continue
        result = selector_results.get(rule.get("id"), {})
        separate = rule.get("mode") == "separate" or rule.get("usedSelector") or rule.get("limitSelector")
        if separate:
            used_rule = {**rule, "pattern": rule.get("usedPattern") or rule.get("pattern"), "flags": rule.get("usedFlags") or rule.get("flags")}
            limit_rule = {**rule, "pattern": rule.get("limitPattern") or rule.get("pattern"), "flags": rule.get("limitFlags") or rule.get("flags")}
            used_raw = _selector_value(first(result.get("usedValues")), used_rule, rule.get("usedGroup", 1))
            limit_raw = _selector_value(first(result.get("limitValues")), limit_rule, rule.get("limitGroup", 1))
        else:
            raw = first(result.get("values"))
            pattern = _rule_regex(rule)
            match = pattern.search(raw) if pattern else None
            numbers = _numeric_values(raw)
            used_raw = _match_group(match, rule.get("usedGroup"), 1) if match else (numbers[0] if numbers else "")
            limit_raw = _match_group(match, rule.get("limitGroup"), 2) if match else (numbers[1] if len(numbers) > 1 else "")
        try:
            used, limit = float(used_raw), float(limit_raw)
        except ValueError:
            diagnostic(rule, result, "parse_failed", "Selected text did not contain a valid used/limit pair")
            continue
        if limit <= 0:
            diagnostic(rule, result, "parse_failed", "Selected text did not contain a positive limit")
            continue
        reset_rule = {**rule, "pattern": rule.get("resetPattern"), "flags": rule.get("resetFlags") or rule.get("flags")}
        reset_in = _selector_value(first(result.get("resetValues")), reset_rule, rule.get("resetGroup", 1), fallback_text=True)
        usage.append(usage_metric(
            str(rule.get("key") or rule.get("id") or "usage"),
            str(rule.get("label") or "用量"),
            round(used / limit * 100),
            _format_quota_value(used_raw, limit_raw, rule.get("currency"), rule.get("symbol")),
            reset_in or None,
        ))
        diagnostic(rule, result, "matched")

    for rule in parser_rules.get("textMetrics", []):
        if not rule.get("selector"):
            continue
        result = selector_results.get(rule.get("id"), {})
        value = _selector_value(first(result.get("values")), rule, rule.get("valueGroup", 1), fallback_text=True)
        if not value:
            diagnostic(rule, result, "not_found")
            continue
        text_metrics.append(text_metric(str(rule.get("key") or rule.get("id") or f"metric_{len(text_metrics) + 1}"), str(rule.get("label") or "指标"), value))
        diagnostic(rule, result, "matched")

    return {
        "balances": balances,
        "usage": usage,
        "textMetrics": text_metrics,
        "metrics": balances + usage + text_metrics,
        "diagnostics": diagnostics,
    }


def generic_page_snapshot(config: ProviderConfig, url: str, parsed: dict[str, Any]) -> dict[str, Any]:
    balances = parsed.get("balances", [])
    usage = parsed.get("usage", [])
    text_metrics = parsed.get("textMetrics", [])
    metrics = balances + usage + text_metrics
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": url,
        "updated_at": now_iso(),
        "checked_at": now_iso(),
        "subscribed": None,
        "balances": balances,
        "usage": usage,
        "metrics": metrics,
        "links": links_for_config(config),
        "recommendation": recommendation_from_usage(usage) if usage else recommendation_from_balances(balances),
        "error": None if metrics else "Page loaded, but no configured provider rules matched",
        "diagnostics": parsed.get("diagnostics", []),
        "raw": {"balance_count": len(balances), "usage_count": len(usage), "metric_count": len(metrics)},
    }


def links_for_config(config: ProviderConfig) -> list[dict[str, str]]:
    return [
        {"label": "打开主页", "url": config.target_url},
        *(config.secondary_urls or []),
    ]


def usage_metric(
    key: str,
    label: str,
    percent: int | None,
    value: str | None,
    reset_in: str | None = None,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "percent": percent,
        "value": value,
        "unit": "%",
        "reset_in": reset_in,
    }


def recommendation_from_usage(usage: list[dict[str, Any]]) -> str:
    highest = max(
        (item["percent"] for item in usage if isinstance(item.get("percent"), int)),
        default=0,
    )
    if highest >= 100:
        return "recharge"
    if highest >= 80:
        return "watch"
    return "ok"


def recommendation_from_balances(
    balances: list[dict[str, Any]],
    is_available: bool | None = True,
) -> str:
    if is_available is False:
        return "recharge"
    totals = [
        float(item["value"])
        for item in balances
        if item.get("key") in ("total_balance", "balance")
        and re.fullmatch(r"-?\d+(?:\.\d+)?", str(item.get("value") or ""))
    ]
    if not totals:
        return "watch"
    if max(totals) <= 0:
        return "recharge"
    if max(totals) < 5:
        return "watch"
    return "ok"


def blank_snapshot(
    config: ProviderConfig,
    status: str = "idle",
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": status,
        "url": config.target_url,
        "updated_at": None,
        "subscribed": None,
        "balances": [],
        "usage": [],
        "metrics": [],
        "channels": [],
        "channelCheckedAt": None,
        "channelsStale": False,
        "channelError": None,
        "links": links_for_config(config),
        "recommendation": "ok" if status == "ok" else "watch",
        "error": error,
    }


def parse_opencode_legacy(tokens: list[str], url: str) -> dict[str, Any]:
    joined = "\n".join(tokens)
    result = {"url": url, "subscribed": "您已订阅 OpenCode Go" in joined, "usage": []}

    idx = 0
    while idx < len(tokens):
        usage_type = tokens[idx]
        if usage_type not in OPENCODE_USAGE_TYPES:
            idx += 1
            continue

        current: dict[str, Any] = {"type": usage_type, "percent": None, "reset_in": None}
        result["usage"].append(current)

        value, value_idx = next_non_usage_token(tokens, idx + 1)
        if value is not None:
            if re.fullmatch(r"\d+%", value):
                current["percent"] = value
                idx = value_idx + 1
            elif re.fullmatch(r"\d+", value):
                suffix, suffix_idx = next_non_usage_token(tokens, value_idx + 1)
                if suffix == "%":
                    current["percent"] = f"{value}%"
                    idx = suffix_idx + 1
                else:
                    idx = value_idx + 1

        for lookahead in range(idx, min(idx + 6, len(tokens))):
            token = tokens[lookahead]
            if token.startswith("重置于"):
                reset_text = token.removeprefix("重置于").strip()
                if reset_text:
                    current["reset_in"] = reset_text
                    idx = lookahead + 1
                else:
                    reset_value, reset_idx = next_non_usage_token(tokens, lookahead + 1)
                    if reset_value is not None:
                        current["reset_in"] = reset_value
                        idx = reset_idx + 1
                break

    if not result["usage"]:
        raise ParserNeedsFixtureError("usage data was not found in the opencode HTML")
    return result


def opencode_snapshot(config: ProviderConfig, legacy: dict[str, Any]) -> dict[str, Any]:
    usage = [
        usage_metric(
            key=item["type"],
            label=item["type"],
            percent=parse_percent(item.get("percent")),
            value=item.get("percent"),
            reset_in=item.get("reset_in"),
        )
        for item in legacy.get("usage", [])
    ]
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": legacy["url"],
        "updated_at": now_iso(),
        "subscribed": legacy.get("subscribed"),
        "balances": legacy.get("balances", []),
        "usage": usage,
        "metrics": legacy.get("balances", []) + usage,
        "links": links_for_config(config),
        "recommendation": recommendation_from_usage(usage),
        "error": None,
        "raw": legacy,
    }


def derive_opencode_billing_url(url: str) -> str:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if parts and parts[-1] == "go":
        parts[-1] = "billing"
    else:
        parts.append("billing")
    return urlunparse(parsed._replace(path="/" + "/".join(parts), query="", fragment=""))


def parse_opencode_balance_tokens(tokens: list[str]) -> list[dict[str, Any]]:
    balances = []
    seen: set[tuple[str, str]] = set()
    money_re = re.compile(r"([$¥￥])\s*(\d+(?:\.\d+)?)")
    keywords = ("余额", "balance", "Balance", "可用余额", "充值", "credit", "Credit")

    for idx, token in enumerate(tokens):
        window = tokens[max(0, idx - 2) : min(len(tokens), idx + 3)]
        if not any(word in "\n".join(window) for word in keywords):
            continue
        for item in window:
            match = money_re.search(item)
            if not match:
                continue
            symbol, amount = match.groups()
            currency = "USD" if symbol == "$" else "CNY"
            label = token if any(word in token for word in keywords) else "余额"
            key = (label, amount)
            if key in seen:
                continue
            seen.add(key)
            balances.append(balance_metric("balance", label, amount, currency))
    return balances


def parse_deepseek_tokens(tokens: list[str], url: str, config: ProviderConfig) -> dict[str, Any]:
    joined = "\n".join(tokens)
    if is_login_html(url, joined, DEEPSEEK_LOGIN_HINTS):
        raise NotLoggedInError("DeepSeek browser profile is not logged in")

    metrics: list[dict[str, Any]] = []
    seen: set[tuple[str, str | None]] = set()
    balance_words = ("余额", "balance", "Balance", "充值余额", "账户余额")
    usage_words = ("用量", "usage", "Usage", "消耗", "消费", "费用")

    for idx, token in enumerate(tokens):
        clean = token.strip()
        if not clean:
            continue

        percent = parse_percent(clean)
        if percent is not None and idx > 0:
            label = tokens[idx - 1].strip()
            key = (label, clean)
            if key not in seen:
                seen.add(key)
                metrics.append(
                    {
                        "label": label,
                        "percent": percent,
                        "value": clean,
                        "unit": "%",
                        "reset_in": None,
                    }
                )
            continue

        if any(word in clean for word in balance_words + usage_words):
            window = tokens[idx : idx + 5]
            value = next(
                (
                    item
                    for item in window
                    if re.search(r"[$¥￥]?\s*\d+(?:\.\d+)?", item)
                    and item.strip() != clean
                ),
                None,
            )
            if value:
                key = (clean, value)
                if key not in seen:
                    seen.add(key)
                    metrics.append(
                        {
                            "label": clean,
                            "percent": None,
                            "value": value,
                            "unit": None,
                            "reset_in": None,
                        }
                    )

    if not metrics:
        dump_path = dump_tokens(config, tokens, title=config.name, url=url)
        raise ParserNeedsFixtureError(
            f"DeepSeek usage fields were not recognized; wrote exploration dump to {dump_path}"
        )

    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": url,
        "updated_at": now_iso(),
        "subscribed": None,
        "balances": [],
        "usage": [],
        "metrics": metrics,
        "links": links_for_config(config),
        "recommendation": "watch",
        "error": None,
        "raw": {"tokens": tokens},
    }


def parse_deepseek_balance(data: dict[str, Any], config: ProviderConfig) -> dict[str, Any]:
    infos = data.get("balance_infos")
    if not isinstance(infos, list):
        raise ProviderError("DeepSeek balance response did not include balance_infos")

    balances = []
    for info in infos:
        if not isinstance(info, dict):
            continue
        currency = info.get("currency")
        balances.extend(
            [
                balance_metric("total_balance", "总余额", info.get("total_balance"), currency),
                balance_metric("granted_balance", "赠金余额", info.get("granted_balance"), currency),
                balance_metric("topped_up_balance", "充值余额", info.get("topped_up_balance"), currency),
            ]
        )
    balances = [item for item in balances if item["value"] != ""]
    if not balances:
        raise ProviderError("DeepSeek balance response did not contain usable balances")

    is_available = data.get("is_available")
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": config.target_url,
        "updated_at": now_iso(),
        "subscribed": None,
        "is_available": is_available,
        "balances": balances,
        "usage": [],
        "metrics": balances,
        "links": links_for_config(config),
        "recommendation": recommendation_from_balances(balances, is_available),
        "error": None,
        "raw": {"is_available": is_available, "balance_infos": infos},
    }


def deepseek_http_error_message(exc: HTTPError) -> str:
    if exc.code == 401:
        return "DeepSeek API Key is invalid or expired"
    if exc.code == 402:
        return "DeepSeek account has insufficient balance"
    if exc.code == 429:
        return "DeepSeek API rate limit was reached"
    return f"DeepSeek balance API returned HTTP {exc.code}"


def parse_money_value(text: str) -> tuple[str, str] | None:
    match = re.search(
        r"([$¥￥])?\s*(\d+(?:\.\d+)?)\s*(CNY|RMB|USD|USDT|元)?",
        text,
        re.I,
    )
    if not match:
        return None
    symbol, amount, suffix = match.groups()
    currency = None
    if symbol == "$":
        currency = "USD"
    elif symbol in ("¥", "￥"):
        currency = "CNY"
    elif suffix:
        normalized = suffix.upper()
        currency = "CNY" if normalized in ("RMB", "元") else normalized
    return amount, currency or ""


def parse_ezaiclub_balance_tokens(tokens: list[str]) -> list[dict[str, Any]]:
    balances = []
    seen: set[tuple[str, str, str]] = set()
    keywords = (
        "余额",
        "充值",
        "可用",
        "剩余",
        "balance",
        "Balance",
        "credit",
        "Credit",
        "wallet",
        "Wallet",
    )

    for idx, token in enumerate(tokens):
        window = tokens[max(0, idx - 2) : min(len(tokens), idx + 4)]
        joined = "\n".join(window)
        if not any(keyword in joined for keyword in keywords):
            continue

        label = next((item for item in window if any(k in item for k in keywords)), token)
        for item in window:
            parsed = parse_money_value(item)
            if not parsed:
                continue
            amount, currency = parsed
            amount = normalize_amount(amount)
            key = ("balance", label, amount)
            if key in seen:
                continue
            seen.add(key)
            balances.append(balance_metric("balance", label, amount, currency or None))

    currency_balances = [item for item in balances if item.get("currency")]
    if currency_balances:
        preferred_labels = ("余额", "账户余额", "可用余额", "可用", "balance", "Balance")
        ordered = sorted(
            currency_balances,
            key=lambda item: 0 if item.get("label") in preferred_labels else 1,
        )
        deduped = []
        seen_amounts: set[tuple[str, str | None]] = set()
        for item in ordered:
            key = (item["value"], item.get("currency"))
            if key in seen_amounts:
                continue
            seen_amounts.add(key)
            deduped.append(item)
        return deduped[:3]

    return balances[:3]


def flatten_json_values(value: Any) -> list[str]:
    result = []
    if isinstance(value, dict):
        for key, item in value.items():
            result.append(str(key))
            result.extend(flatten_json_values(item))
    elif isinstance(value, list):
        for item in value:
            result.extend(flatten_json_values(item))
    elif value is not None:
        result.append(str(value))
    return result


def extract_json_payloads(responses: list[dict[str, Any]]) -> list[str]:
    tokens = []
    for response in responses:
        tokens.extend(flatten_json_values(response.get("data")))
    return [token.strip() for token in tokens if token and token.strip()]


def next_subscription_value(tokens: list[str], start: int) -> str | None:
    skip_words = (
        "订阅",
        "套餐",
        "subscription",
        "Subscription",
        "plan",
        "Plan",
        "planName",
        "plan_name",
        "expiresAt",
        "expires_at",
        "endDate",
        "renewAt",
        "renew_at",
        "有效",
        "续费",
    )
    for idx in range(start, min(start + 4, len(tokens))):
        token = tokens[idx].strip()
        if not token or token in skip_words:
            continue
        if len(token) > 120:
            continue
        return token
    return None


def normalize_subscription_label(label: str) -> str:
    clean = label.strip()
    mappings = (
        (re.compile(r"^(plan_name|planName|subscription_plan|subscriptionPlan)$", re.I), "当前套餐"),
        (re.compile(r"^(expires_at|expiresAt|endDate|renewAt|renew_at)$", re.I), "到期时间"),
        (re.compile(r"^(subscription_status|status)$", re.I), "订阅状态"),
        (re.compile(r"^(subscription_usage|usage)$", re.I), "订阅用量"),
        (re.compile(r"^(current_plan|currentPlan)$", re.I), "当前套餐"),
    )
    for pattern, normalized in mappings:
        if pattern.search(clean):
            return normalized
    return clean


def format_subscription_amount(amount: str) -> str:
    try:
        return f"{float(amount):.2f}"
    except ValueError:
        return amount


def subscription_reset_near(tokens: list[str], idx: int) -> str | None:
    for token in tokens[idx + 1 : min(len(tokens), idx + 5)]:
        match = re.search(r"(.+?)\s*后重置", token.strip())
        if match:
            return match.group(1).strip()
    return None


def subscription_period_near(tokens: list[str], idx: int) -> str | None:
    period_map = {
        "每日": "每日",
        "每天": "每日",
        "每周": "每周",
        "每月": "每月",
        "daily": "每日",
        "weekly": "每周",
        "monthly": "每月",
    }
    for token in reversed(tokens[max(0, idx - 5) : idx]):
        clean = token.strip()
        mapped = period_map.get(clean) or period_map.get(clean.lower())
        if mapped:
            return mapped
    return None


def subscription_expiry_near(tokens: list[str], idx: int, date_re: re.Pattern[str]) -> str | None:
    window = "\n".join(tokens[max(0, idx - 4) : min(len(tokens), idx + 5)])
    remaining_match = re.search(r"剩余\s*[^()]*\(([^)]+)\)", window)
    if remaining_match:
        return remaining_match.group(1).strip()
    date_match = date_re.search(window)
    return date_match.group(0) if date_match else None


def parse_ezaiclub_subscription_tokens(tokens: list[str]) -> list[dict[str, Any]]:
    metrics = []
    seen: set[tuple[str, str]] = set()
    nav_tokens = {
        "充值/订阅",
        "模型价格",
        "文档",
        "查看您的订阅计划和用量",
        "我的订阅",
    }
    keywords = (
        "订阅",
        "套餐",
        "到期",
        "续费",
        "有效",
        "subscription",
        "Subscription",
        "plan",
        "Plan",
        "planName",
        "plan_name",
        "currentPlan",
        "current_plan",
        "active",
        "Active",
        "expires",
        "Expires",
        "expiresAt",
        "expires_at",
        "endDate",
        "renew",
        "Renew",
        "renewAt",
        "renew_at",
        "status",
        "usage",
        "subscription_status",
        "subscription_usage",
    )
    date_re = re.compile(
        r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:[ T]\d{1,2}:\d{2})?|"
        r"[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}"
    )
    quota_pair_re = re.compile(r"([$¥￥])\s*(\d+(?:\.\d+)?)\s*/\s*([$¥￥])?\s*(\d+(?:\.\d+)?)")
    period_fields = (
        ("daily", "每日"),
        ("weekly", "每周"),
        ("monthly", "每月"),
    )

    def add_text(label: str, value: str, key_name: str | None = None) -> None:
        normalized_label = normalize_subscription_label(label)
        normalized_value = value.strip()
        if not normalized_value or normalized_value in nav_tokens:
            return
        if normalized_label == "到期时间":
            normalized_value = normalized_value.replace("T", " ")
        if normalized_value == "allowed_groups" or "_" in normalized_value and normalized_label != "到期时间":
            return
        key = (normalized_label, normalized_value)
        if key in seen:
            return
        seen.add(key)
        metrics.append(text_metric(key_name or f"subscription_{len(metrics) + 1}", normalized_label, normalized_value))

    def add_usage(label: str, value: str, percent: int | None, reset_in: str | None) -> None:
        key = (label, value)
        if key in seen:
            if reset_in:
                for metric in metrics:
                    if (
                        metric.get("label") == label
                        and metric.get("value") == value
                        and not metric.get("reset_in")
                    ):
                        metric["reset_in"] = reset_in
                        break
            return
        seen.add(key)
        metrics.append(usage_metric("subscription_usage", label, percent, value, reset_in))

    def add_api_usage(period: str, label_prefix: str) -> bool:
        usage_key = f"{period}_usage_usd"
        limit_key = f"{period}_limit_usd"
        try:
            usage_idx = next(i for i, token in enumerate(tokens) if token.strip() == usage_key)
            limit_idx = next(i for i, token in enumerate(tokens) if token.strip() == limit_key)
        except StopIteration:
            return False
        if usage_idx + 1 >= len(tokens) or limit_idx + 1 >= len(tokens):
            return False
        used_raw = tokens[usage_idx + 1].strip()
        limit_raw = tokens[limit_idx + 1].strip()
        try:
            used = float(used_raw)
            limit = float(limit_raw)
        except ValueError:
            return False
        if limit <= 0:
            return False
        percent = round(used / limit * 100)
        add_usage(
            f"{label_prefix}用量",
            f"${format_subscription_amount(used_raw)} / ${format_subscription_amount(limit_raw)}",
            percent,
            None,
        )
        return True

    has_usage_quota = False
    for period, label_prefix in period_fields:
        has_usage_quota = add_api_usage(period, label_prefix) or has_usage_quota

    for idx, token in enumerate(tokens):
        clean = token.strip()
        quota_match = quota_pair_re.search(clean)
        if not quota_match:
            continue
        symbol, used_raw, limit_symbol, limit_raw = quota_match.groups()
        try:
            used = float(used_raw)
            limit = float(limit_raw)
        except ValueError:
            continue
        if limit <= 0:
            continue
        label_prefix = subscription_period_near(tokens, idx)
        label = f"{label_prefix}用量" if label_prefix else "订阅用量"
        percent = round(used / limit * 100)
        display_symbol = symbol or limit_symbol or "$"
        value = (
            f"{display_symbol}{format_subscription_amount(used_raw)} / "
            f"{limit_symbol or display_symbol}{format_subscription_amount(limit_raw)}"
        )
        add_usage(label, value, percent, subscription_reset_near(tokens, idx))
        has_usage_quota = True
        expires_at = subscription_expiry_near(tokens, idx, date_re)
        if expires_at:
            add_text("到期时间", expires_at)

    for idx, token in enumerate(tokens):
        clean = token.strip()
        if not clean or not any(keyword in clean for keyword in keywords):
            continue
        if clean in ("Subscriptions", "Subscription", "订阅"):
            continue
        if clean in nav_tokens:
            continue
        if clean in {"last_active_at", "有效", "续费"} or "同一订阅重复" in clean:
            continue
        if re.fullmatch(r"(daily|weekly|monthly)_(usage|limit)_usd", clean):
            continue
        if len(clean) > 48 and "已达到" not in clean:
            continue
        percent_match = re.search(r"已达到\s*(\d+)%", clean)
        if percent_match:
            if has_usage_quota:
                continue
            date_match = date_re.search("\n".join(tokens[idx : idx + 5]))
            value = f"{percent_match.group(1)}%"
            if date_match:
                value = f"{value}, 到期 {date_match.group(0)}"
            add_text("订阅用量", value, "subscription_usage")
            continue
        value = next_subscription_value(tokens, idx + 1)
        date_match = date_re.search("\n".join(tokens[idx : idx + 5]))
        if date_match and any(word in clean for word in ("到期", "续费", "有效", "expires", "Expires", "renew", "Renew")):
            value = date_match.group(0)
        if not value and len(clean) <= 120:
            value = clean
        if not value:
            continue
        if value in nav_tokens:
            continue
        if "_" in value or value in {"allowed_groups"}:
            continue
        add_text(clean, value)
        if len(metrics) >= 6:
            break
    return metrics


def parse_siliconflow_balance_tokens(tokens: list[str]) -> list[dict[str, Any]]:
    balances = []
    seen: set[tuple[str, str, str | None]] = set()
    keywords = (
        "余额",
        "可用",
        "剩余",
        "赠金",
        "充值",
        "券",
        "优惠券",
        "代金券",
        "coupon",
        "Coupon",
        "credit",
        "Credit",
        "balance",
        "Balance",
        "amount",
        "Amount",
    )
    preferred_labels = ("可用余额", "账户余额", "余额", "赠金", "优惠券", "代金券", "balance", "Balance")

    def add_balance(label: str, amount: str, currency: str | None) -> None:
        amount = normalize_amount(amount)
        key = (label, amount, currency or None)
        if key in seen:
            return
        seen.add(key)
        balances.append(balance_metric("balance", label, amount, currency or None))

    def previous_coupon_label(idx: int) -> str | None:
        for item in reversed(tokens[max(0, idx - 4) : idx]):
            clean = item.strip()
            if not clean or len(clean) > 48:
                continue
            if re.fullmatch(r"\d+(?:\.\d+)?", clean):
                continue
            if clean in {"全部", "可用", "兑换中心"}:
                continue
            return clean
        return None

    for idx, token in enumerate(tokens):
        quota_match = re.search(
            r"剩余额度[:：]\s*([$¥￥])?\s*(\d+(?:\.\d+)?)\s*(CNY|RMB|USD|USDT|元)?",
            token,
            re.I,
        )
        if quota_match:
            symbol, amount, suffix = quota_match.groups()
            currency = None
            if symbol == "$":
                currency = "USD"
            elif symbol in ("¥", "￥"):
                currency = "CNY"
            elif suffix:
                normalized = suffix.upper()
                currency = "CNY" if normalized in ("RMB", "元") else normalized
            prefix = previous_coupon_label(idx)
            label = f"{prefix}剩余额度" if prefix else "剩余额度"
            add_balance(label, amount, currency)
            continue

        window = tokens[max(0, idx - 2) : min(len(tokens), idx + 5)]
        joined = "\n".join(window)
        if not any(keyword in joined for keyword in keywords):
            continue

        keyword_items = [
            (offset, item)
            for offset, item in enumerate(window)
            if any(keyword in item for keyword in keywords)
        ]
        for offset, item in enumerate(window):
            clean = item.strip()
            if not clean or len(clean) > 80:
                continue
            if re.search(r"\d{4}[-/年]\d{1,2}|^\d+%$", clean):
                continue
            has_currency = bool(re.search(r"[$¥￥]|(?:CNY|RMB|USD|USDT|元)\b", clean, re.I))
            near_currency = next(
                (
                    "CNY" if item.strip().upper() in ("RMB", "元") else item.strip().upper()
                    for item in window
                    if item.strip().upper() in ("CNY", "RMB", "USD", "USDT", "元")
                ),
                None,
            )
            has_currency = has_currency or near_currency is not None
            if not has_currency:
                continue
            parsed = parse_money_value(clean)
            if not parsed:
                continue
            label = min(keyword_items, key=lambda pair: abs(pair[0] - offset))[1] if keyword_items else token
            if len(label) > 80:
                label = token
            label = re.sub(
                r"[（(]?\s*[$¥￥]\s*\d+(?:\.\d+)?\s*[）)]?",
                "",
                label,
            ).strip("（）() ") or label
            amount, currency = parsed
            add_balance(label, amount, currency or near_currency)

    ordered = sorted(
        balances,
        key=lambda item: 0 if item.get("label") in preferred_labels else 1,
    )
    deduped = []
    seen_amounts: set[tuple[str, str | None]] = set()
    for item in ordered:
        key = (item["value"], item.get("currency"))
        if key in seen_amounts:
            continue
        seen_amounts.add(key)
        deduped.append(item)
    return deduped[:5]


def parse_siliconflow_metric_tokens(tokens: list[str]) -> list[dict[str, Any]]:
    metrics = []
    seen: set[tuple[str, str]] = set()
    keywords = (
        "账单",
        "费用",
        "消费",
        "消耗",
        "使用",
        "到期",
        "有效",
        "过期",
        "充值",
        "expense",
        "Expense",
        "bill",
        "Bill",
        "used",
        "Used",
        "expires",
        "Expires",
        "valid",
        "Valid",
    )
    ignored_labels = {
        "used",
        "expiresAt",
        "quota",
        "total",
        "remain",
        "remaining",
        "余额充值",
        "费用明细",
    }
    date_re = re.compile(
        r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(?:\s*~\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2})?|"
        r"[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}"
    )

    def add_metric(label: str, value: str) -> None:
        key = (label, value)
        if key in seen:
            return
        seen.add(key)
        metrics.append(text_metric(f"siliconflow_metric_{len(metrics) + 1}", label, value))

    for idx, token in enumerate(tokens):
        clean = token.strip()
        if not clean or len(clean) > 80:
            continue
        if clean in ignored_labels:
            continue
        if clean == "代金券" and idx + 2 < len(tokens):
            count = tokens[idx + 1].strip()
            suffix = tokens[idx + 2].strip()
            if re.fullmatch(r"\d+", count) and "张可用" in suffix:
                add_metric("代金券", f"{count} 张可用")
            continue
        if not any(keyword in clean for keyword in keywords):
            continue
        window = tokens[idx : min(len(tokens), idx + 5)]
        value = None
        date_match = date_re.search("\n".join(window))
        if date_match:
            value = date_match.group(0)
        if value is None:
            value = next(
                (
                    item.strip()
                    for item in window[1:]
                    if item.strip()
                    and len(item.strip()) <= 80
                    and re.search(r"[$¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:CNY|RMB|USD|USDT|元)\b|\d+%", item, re.I)
                ),
                None,
            )
        if not value:
            continue
        add_metric(clean, value)
        if len(metrics) >= 6:
            break
    return metrics


def siliconflow_snapshot(
    config: ProviderConfig,
    url: str,
    balances: list[dict[str, Any]],
    metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    all_metrics = balances + metrics
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": url,
        "updated_at": now_iso(),
        "subscribed": None,
        "balances": balances,
        "usage": [],
        "metrics": all_metrics,
        "links": links_for_config(config),
        "recommendation": recommendation_from_balances(balances),
        "error": None if all_metrics else "SiliconFlow page loaded, but no balance or coupon fields were recognized",
        "raw": {
            "balance_count": len(balances),
            "metric_count": len(metrics),
        },
    }


def ezaiclub_snapshot(
    config: ProviderConfig,
    dashboard_url: str,
    balances: list[dict[str, Any]],
    subscription_metrics: list[dict[str, Any]],
    channels: list[dict[str, Any]] | None = None,
    channel_error: str | None = None,
) -> dict[str, Any]:
    metrics = balances + subscription_metrics
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": dashboard_url,
        "updated_at": now_iso(),
        "subscribed": None,
        "balances": balances,
        "usage": [],
        "metrics": metrics,
        "channels": channels,
        "channelCheckedAt": now_iso() if channels is not None else None,
        "channelsStale": False,
        "channelError": channel_error,
        "links": links_for_config(config),
        "recommendation": recommendation_from_balances(balances),
        "error": None if metrics else "EZAICLUB pages loaded, but no balance or subscription fields were recognized",
        "raw": {
            "balance_count": len(balances),
            "subscription_metric_count": len(subscription_metrics),
        },
    }


def _payload_data(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict) or payload.get("code") in {401, "UNAUTHORIZED"}:
        return None
    data = payload.get("data", payload)
    return data if isinstance(data, dict) else None


def _first_present(data: dict[str, Any] | None, keys: tuple[str, ...]) -> Any:
    if not isinstance(data, dict):
        return None
    return next((data[key] for key in keys if data.get(key) not in (None, "")), None)


def _find_present_deep(data: Any, keys: tuple[str, ...], depth: int = 0) -> Any:
    if depth > 4:
        return None
    if isinstance(data, dict):
        direct = _first_present(data, keys)
        if direct is not None:
            return direct
        values = data.values()
    elif isinstance(data, list):
        values = data
    else:
        return None
    for value in values:
        found = _find_present_deep(value, keys, depth + 1)
        if found is not None:
            return found
    return None


def newapi_snapshot(config: ProviderConfig, url: str, payload: Any) -> dict[str, Any]:
    data = _payload_data(payload)
    if not data or data.get("quota") is None and data.get("used_quota") is None:
        raise ProviderError("New API self payload did not contain quota fields")
    quota_per_unit = config.quota_per_unit or 500000
    remaining = float(data["quota"]) / quota_per_unit if data.get("quota") is not None else None
    used = float(data.get("used_quota") or 0) / quota_per_unit
    total = remaining + used if remaining is not None else None
    balances = [balance_metric("balance", "剩余额度", f"{remaining:.2f}", "USD")] if remaining is not None else []
    usage = []
    if total and total > 0:
        usage.append(usage_metric("quota_usage", "额度用量", round(used / total * 100), f"${used:.2f} / ${total:.2f}"))
    text_metrics = []
    if data.get("request_count") is not None:
        text_metrics.append(text_metric("request_count", "请求次数", str(data["request_count"])))
    account = data.get("display_name") or data.get("username")
    if account:
        text_metrics.append(text_metric("account", "账号", str(account)))
    metrics = balances + usage + text_metrics
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": url,
        "updated_at": now_iso(),
        "subscribed": None,
        "balances": balances,
        "usage": usage,
        "metrics": metrics,
        "links": links_for_config(config),
        "recommendation": recommendation_from_balances(balances),
        "error": None if metrics else "New API returned an empty user quota payload",
    }


def sub2api_snapshot(
    config: ProviderConfig,
    url: str,
    auth_payload: Any,
    stats_payload: Any = None,
    channels: list[dict[str, Any]] | None = None,
    channel_error: str | None = None,
) -> dict[str, Any]:
    user = _payload_data(auth_payload)
    if not user:
        raise ProviderError("Sub2API auth payload did not contain user fields")
    stats = _payload_data(stats_payload) or {}
    balance = _first_present(user, ("balance", "remaining_balance", "available_balance"))
    frozen = _first_present(user, ("frozen_balance", "frozenBalance"))
    balances = [balance_metric("balance", "余额", f"{float(balance):.2f}", "USD")] if balance is not None else []
    if frozen is not None and float(frozen) > 0:
        balances.append(balance_metric("frozen_balance", "冻结余额", f"{float(frozen):.2f}", "USD"))
    text_metrics = []
    account = _first_present(user, ("display_name", "displayName", "username", "name", "email"))
    if account:
        text_metrics.append(text_metric("account", "账号", str(account)))
    today_requests = _find_present_deep(stats, ("today_requests", "todayRequests", "today_request_count", "todayRequestCount"))
    total_requests = _find_present_deep(stats, ("total_requests", "totalRequests", "request_count", "requestCount"))
    if today_requests is not None:
        text_metrics.append(text_metric("today_requests", "今日请求", str(today_requests)))
    if total_requests is not None:
        text_metrics.append(text_metric("total_requests", "总请求", str(total_requests)))
    usage = []
    for key, label, used_keys, limit_keys in (
        ("today_cost", "今日消费", ("today_actual_cost", "todayActualCost", "today_cost", "todayCost"), ("today_standard_cost", "todayStandardCost", "today_quota_cost", "todayQuotaCost")),
        ("total_cost", "累计消费", ("total_actual_cost", "totalActualCost", "total_cost", "totalCost"), ("total_standard_cost", "totalStandardCost", "total_quota_cost", "totalQuotaCost")),
    ):
        used_raw = _find_present_deep(stats, used_keys)
        limit_raw = _find_present_deep(stats, limit_keys)
        try:
            used, limit = float(used_raw), float(limit_raw)
        except (TypeError, ValueError):
            continue
        if limit > 0:
            usage.append(usage_metric(key, label, round(used / limit * 100), f"${used:.2f} / ${limit:.2f}"))
    metrics = balances + usage + text_metrics
    return {
        "id": config.id,
        "name": config.name,
        "type": config.type,
        "status": "ok",
        "url": url,
        "updated_at": now_iso(),
        "subscribed": None,
        "balances": balances,
        "usage": usage,
        "metrics": metrics,
        "channels": channels,
        "channelCheckedAt": now_iso() if channels is not None else None,
        "channelsStale": False,
        "channelError": channel_error,
        "links": links_for_config(config),
        "recommendation": recommendation_from_usage(usage) if usage else recommendation_from_balances(balances),
        "error": None if metrics else "Sub2API returned an empty dashboard payload",
    }


def dump_tokens(
    config: ProviderConfig,
    tokens: list[str],
    title: str,
    url: str,
    suffix: str | None = None,
) -> Path:
    DEFAULT_DUMP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{config.id}-{suffix}.txt" if suffix else f"{config.id}.txt"
    path = DEFAULT_DUMP_DIR / name
    lines = [
        f"TITLE: {title}",
        f"URL:   {url}",
        "=" * 60,
        "--- VISIBLE TEXT ---",
        "\n".join(tokens),
        "=" * 60,
        "--- USAGE-RELATED TOKENS ---",
    ]
    lines.extend(token for token in tokens if USAGE_HINTS.search(token))
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class Provider:
    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    def uses_browser(self) -> bool:
        return self.config.mode != "api" and self.config.type != "deepseek"

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def explore(self, browser: BrowserSession | None = None) -> Path:
        with self.browser_page(browser) as page:
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            wait_for_page_ready(page, DEFAULT_READY_PATTERN, min_wait_ms=800, timeout_ms=12000)
            return dump_tokens(self.config, page_tokens(page), page.title(), page.url)

    @contextmanager
    def browser_page(self, browser: BrowserSession | None = None) -> Iterator[Any]:
        if browser is not None:
            yield browser.page()
            return
        session = BrowserSession(self.config.profile_dir)
        session.start()
        try:
            yield session.page()
        finally:
            session.close()


class BrowserJsonProvider(Provider):
    login_hints: tuple[str, ...] = ()
    login_error = "BrowserOS profile is not logged in"
    default_host = ""
    ready_pattern: re.Pattern[str] = DEFAULT_READY_PATTERN

    def page_api_json(self, page, url: str) -> Any:
        result = page.evaluate(
            """
            async (url) => {
              const token = globalThis.localStorage?.getItem("auth_token") || "";
              const headers = { Accept: "application/json" };
              if (token) headers.Authorization = `Bearer ${token}`;
              const response = await fetch(url, { headers, credentials: "include" });
              let data = null;
              try { data = await response.json(); } catch { data = null; }
              return { ok: response.ok, status: response.status, data, hasToken: Boolean(token) };
            }
            """,
            url,
        )
        if result.get("status") in (401, 403):
            raise NotLoggedInError(self.login_error)
        if not result.get("ok"):
            raise ProviderError(f"{self.config.name} API returned HTTP {result.get('status')}")
        return result.get("data")

    def capture_json_responses(
        self,
        page,
        responses: list[dict[str, Any]],
        host: str | None = None,
    ) -> None:
        target_host = host or urlparse(self.config.target_url).hostname or self.default_host

        def handle_response(response) -> None:
            try:
                response_host = urlparse(response.url).hostname
                content_type = response.headers.get("content-type", "")
                if response_host != target_host or "json" not in content_type.lower():
                    return
                responses.append({"url": response.url, "data": response.json()})
            except Exception:
                return

        page.on("response", handle_response)

    def goto_with_json(
        self,
        page,
        url: str,
        host: str | None = None,
        timeout: int = 60000,
        ready_pattern: re.Pattern[str] | None = None,
        min_wait_ms: int = 1500,
        timeout_ms: int = 18000,
    ) -> tuple[str, list[str], list[dict[str, Any]]]:
        responses: list[dict[str, Any]] = []
        self.capture_json_responses(page, responses, host)
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        body_text = wait_for_page_ready(
            page,
            ready_pattern=ready_pattern or self.ready_pattern,
            timeout_ms=timeout_ms,
            min_wait_ms=min_wait_ms,
        )
        login_probe = page.title() + "\n" + body_text
        if is_login_html(page.url, login_probe, self.login_hints):
            raise NotLoggedInError(self.login_error)
        tokens = [line.strip() for line in body_text.splitlines() if line.strip()]
        tokens.extend(extract_json_payloads(responses))
        return page.url, tokens, responses


class GenericPageProvider(Provider):
    def _read_values(self, page, selector: Any, attribute: Any = "textContent", index: Any = None) -> dict[str, Any]:
        if not selector:
            return {"values": [], "matchCount": 0}
        locator = page.locator(str(selector))
        count = min(locator.count(), 50)
        indexes = [max(0, int(index))] if index not in (None, "") else list(range(count))
        values = []
        for item_index in indexes:
            if item_index >= count:
                continue
            node = locator.nth(item_index)
            name = str(attribute or "textContent")
            if name == "innerText":
                value = node.inner_text()
            elif name == "textContent":
                value = node.text_content()
            elif name == "value":
                value = node.input_value()
            else:
                value = node.get_attribute(name)
            text = str(value or "").strip()[:10000]
            if text:
                values.append(text)
        return {"values": values, "matchCount": count}

    def _selector_results(self, page, rules: list[dict[str, Any]]) -> dict[str, Any]:
        results = {}
        for rule in rules:
            result = self._read_values(page, rule.get("selector"), rule.get("attribute"), rule.get("index"))
            used = self._read_values(page, rule.get("usedSelector"), rule.get("usedAttribute") or rule.get("attribute"), rule.get("usedIndex", rule.get("index")))
            limit = self._read_values(page, rule.get("limitSelector"), rule.get("limitAttribute") or rule.get("attribute"), rule.get("limitIndex", rule.get("index")))
            reset = self._read_values(page, rule.get("resetSelector"), rule.get("resetAttribute") or "textContent", rule.get("resetIndex"))
            results[str(rule.get("id"))] = {
                **result,
                "usedValues": used["values"],
                "limitValues": limit["values"],
                "resetValues": reset["values"],
                "usedMatchCount": used["matchCount"],
                "limitMatchCount": limit["matchCount"],
                "resetMatchCount": reset["matchCount"],
            }
        return results

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        parser_rules = self.config.parser_rules or {}
        rule_lists = [parser_rules.get(name, []) for name in ("balances", "quotas", "textMetrics")]
        if not any(rule_lists):
            raise ProviderError("Generic page provider has no parser rules")
        login_hints = tuple(str(item) for item in parser_rules.get("loginHints", []) if item)
        ready_pattern = _rule_regex({"pattern": parser_rules.get("readyPattern"), "flags": "i"})
        wait_options = parser_rules.get("waitOptions") if isinstance(parser_rules.get("waitOptions"), dict) else {}
        pages = [
            {"id": "main", "url": self.config.target_url, "required": True},
            *[{"id": item.get("id") or f"page-{index + 1}", "url": item["url"], "required": False}
              for index, item in enumerate(self.config.secondary_urls or [])],
        ]
        tokens: list[str] = []
        selector_results: dict[str, Any] = {}
        snapshot_url = self.config.target_url
        with self.browser_page(browser) as page:
            for page_config in pages:
                page_rules = [
                    rule
                    for rules in rule_lists
                    for rule in rules
                    if str(rule.get("pageId") or "main") == page_config["id"]
                    and any(rule.get(name) for name in ("selector", "usedSelector", "limitSelector"))
                ]
                try:
                    page.goto(page_config["url"], wait_until="domcontentloaded", timeout=60000)
                    ready_selector = parser_rules.get("readySelector")
                    if ready_selector:
                        try:
                            page.wait_for_selector(str(ready_selector), timeout=12000)
                        except Exception:
                            pass
                    after_load_delay = int(parser_rules.get("afterLoadDelayMs") or 0)
                    if after_load_delay:
                        page.wait_for_timeout(after_load_delay)
                    body_text = wait_for_page_ready(
                        page,
                        ready_pattern or DEFAULT_READY_PATTERN,
                        timeout_ms=int(wait_options.get("waitMs") or 18000),
                        min_wait_ms=int(wait_options.get("minWaitMs") or 800),
                        stable_samples=int(wait_options.get("stableSamples") or 3),
                        poll_ms=int(wait_options.get("pollMs") or 400),
                    )
                    login_probe = f"{page.url}\n{page.title()}\n{body_text}"
                    if login_hints and is_login_html(page.url, login_probe, login_hints):
                        raise NotLoggedInError(f"BrowserOS profile is not logged in to {self.config.name}")
                    if page_config["required"]:
                        snapshot_url = page.url
                    tokens.extend(line.strip() for line in body_text.splitlines() if line.strip())
                    selector_results.update(self._selector_results(page, page_rules))
                except NotLoggedInError:
                    raise
                except Exception:
                    if page_config["required"] or page_rules:
                        raise

        token_parsed = parse_generic_page_tokens(tokens, parser_rules)
        selector_parsed = parse_generic_selector_results(selector_results, parser_rules)
        parsed = {
            "balances": token_parsed["balances"] + selector_parsed["balances"],
            "usage": token_parsed["usage"] + selector_parsed["usage"],
            "textMetrics": token_parsed["textMetrics"] + selector_parsed["textMetrics"],
            "diagnostics": selector_parsed["diagnostics"],
        }
        return generic_page_snapshot(self.config, snapshot_url, parsed)


class OpenCodeProvider(Provider):
    def uses_browser(self) -> bool:
        return True

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        if not self.config.cookie_cache:
            raise MissingCookieError("opencode cookie_cache is not configured")

        try:
            cookies = (
                self.refresh_cookies(browser=browser)
                if refresh_auth
                else load_cookie_cache(self.config.cookie_cache)
            )
            html, url = request_html(self.config.target_url, cookies, OPENCODE_LOGIN_HINTS)
            legacy = parse_opencode_legacy(html_tokens(html), url)
            legacy["balances"] = self.fetch_balances(cookies)
            return opencode_snapshot(self.config, legacy)
        except (MissingCookieError, NotLoggedInError):
            if refresh_auth:
                raise
            try:
                cookies = self.refresh_cookies(browser=browser)
                html, url = request_html(self.config.target_url, cookies, OPENCODE_LOGIN_HINTS)
                legacy = parse_opencode_legacy(html_tokens(html), url)
                legacy["balances"] = self.fetch_balances(cookies)
                return opencode_snapshot(self.config, legacy)
            except Exception:
                if not browser_fallback:
                    raise
                return self.browser_fetch(browser=browser)
        except Exception:
            if not browser_fallback:
                raise
            return self.browser_fetch(browser=browser)

    def refresh_cookies(self, browser: BrowserSession | None = None) -> list[dict[str, Any]]:
        host = urlparse(self.config.target_url).hostname or "opencode.ai"
        with self.browser_page(browser) as page:
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            wait_for_page_ready(page, OPENCODE_READY_PATTERN, min_wait_ms=800, timeout_ms=12000)
            html = page.content()
            if is_login_html(page.url, html, OPENCODE_LOGIN_HINTS):
                raise NotLoggedInError("BrowserOS profile is not logged in to opencode.ai")
            context = browser.context if browser is not None else page.context
            return save_cookie_cache(
                self.config.cookie_cache or "",
                context.cookies(self.config.target_url),
                host,
            )

    def fetch_balances(self, cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
        billing_url = derive_opencode_billing_url(self.config.target_url)
        html = ""
        try:
            html, _ = request_html(billing_url, cookies, OPENCODE_LOGIN_HINTS)
            balances = parse_opencode_balance_tokens(html_tokens(html))
        except Exception:
            return []
        if not balances and html:
            dump_tokens(
                self.config,
                html_tokens(html),
                title=f"{self.config.name} Billing",
                url=billing_url,
            )
        return balances

    def browser_fetch(self, browser: BrowserSession | None = None) -> dict[str, Any]:
        with self.browser_page(browser) as page:
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            wait_for_page_ready(page, OPENCODE_READY_PATTERN, min_wait_ms=800, timeout_ms=12000)
            html = page.content()
            if is_login_html(page.url, html, OPENCODE_LOGIN_HINTS):
                raise NotLoggedInError("BrowserOS profile is not logged in to opencode.ai")
            legacy = parse_opencode_legacy(page_tokens(page), page.url)
            legacy["balances"] = self.browser_billing_balances(page)
            return opencode_snapshot(self.config, legacy)

    def browser_billing_balances(self, page) -> list[dict[str, Any]]:
        billing_url = derive_opencode_billing_url(self.config.target_url)
        try:
            page.goto(billing_url, wait_until="domcontentloaded", timeout=60000)
            wait_for_page_ready(page, OPENCODE_READY_PATTERN, min_wait_ms=800, timeout_ms=10000)
            tokens = page_tokens(page)
            balances = parse_opencode_balance_tokens(tokens)
            if not balances:
                dump_tokens(self.config, tokens, title=page.title(), url=page.url)
            return balances
        except Exception:
            return []


class DeepSeekProvider(Provider):
    def uses_browser(self) -> bool:
        return False

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        api_key_env = self.config.api_key_env or "DEEPSEEK_API_KEY"
        api_key = os.environ.get(api_key_env) or load_local_secret("deepseek_api_key")
        if not api_key:
            return blank_snapshot(
                self.config,
                status="unconfigured",
                error=f"Set {api_key_env} to collect DeepSeek balance",
            )

        request = Request(
            DEEPSEEK_BALANCE_URL,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )
        try:
            response = urlopen(request, timeout=20)
            charset = response.headers.get_content_charset() or "utf-8"
            data = json.loads(response.read().decode(charset, "replace"))
            return parse_deepseek_balance(data, self.config)
        except HTTPError as exc:
            raise ProviderError(deepseek_http_error_message(exc)) from exc


class ChannelApiProvider(BrowserJsonProvider):
    def origin_url(self, path: str) -> str:
        parsed = urlparse(self.config.target_url)
        return f"{parsed.scheme}://{parsed.netloc}{path}"

    def fetch_channel_payloads(
        self,
        page,
        available_path: str,
        timezone_name: str | None = None,
    ) -> tuple[Any, Any, Any, str | None]:
        suffix = f"?timezone={quote(timezone_name, safe='')}" if timezone_name else ""
        requests = (
            ("渠道状态", f"/api/v1/channel-monitors{suffix}"),
            ("渠道分组", available_path),
            ("用户倍率", "/api/v1/groups/rates"),
        )
        payloads = []
        errors = []
        for label, path in requests:
            try:
                payloads.append(self.page_api_json(page, self.origin_url(path)))
            except NotLoggedInError:
                raise
            except Exception as exc:
                payloads.append(None)
                errors.append(f"{label}: {exc}")
        if errors:
            return None, None, None, "; ".join(errors)[:500]
        return payloads[0], payloads[1], payloads[2], None


class NewAPIProvider(BrowserJsonProvider):
    login_hints = NEWAPI_LOGIN_HINTS
    login_error = "BrowserOS profile is not logged in to this New API provider"
    ready_pattern = DEFAULT_READY_PATTERN

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        with self.browser_page(browser) as page:
            page_url, _, _ = self.goto_with_json(page, self.config.target_url, min_wait_ms=800)
            payload = self.page_api_json(page, self.origin_url("/api/user/self"))
            return newapi_snapshot(self.config, page_url, payload)

    def origin_url(self, path: str) -> str:
        parsed = urlparse(self.config.target_url)
        return f"{parsed.scheme}://{parsed.netloc}{path}"


class Sub2APIProvider(ChannelApiProvider):
    login_hints = SUB2API_LOGIN_HINTS
    login_error = "BrowserOS profile is not logged in to this Sub2API provider"
    ready_pattern = DEFAULT_READY_PATTERN

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        with self.browser_page(browser) as page:
            page_url, _, _ = self.goto_with_json(page, self.config.target_url, min_wait_ms=1000)
            timezone_query = quote("Asia/Shanghai", safe="")
            auth_payload = self.page_api_json(page, self.origin_url(f"/api/v1/auth/me?timezone={timezone_query}"))
            try:
                stats_payload = self.page_api_json(
                    page,
                    self.origin_url(f"/api/v1/usage/dashboard/stats?timezone={timezone_query}"),
                )
            except Exception:
                stats_payload = None
            monitors, groups, rates, channel_error = self.fetch_channel_payloads(
                page,
                "/api/v1/channels/available",
            )
            channels = None if channel_error else parse_sub2api_channels(self.config, monitors, groups, rates)
            return sub2api_snapshot(
                self.config,
                page_url,
                auth_payload,
                stats_payload,
                channels=channels,
                channel_error=channel_error,
            )


class EZAICLUBProvider(ChannelApiProvider):
    login_hints = EZAICLUB_LOGIN_HINTS
    login_error = "BrowserOS profile is not logged in to EZAICLUB"
    default_host = "www.ezaiclub.com"
    ready_pattern = EZAICLUB_BALANCE_READY_PATTERN

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        with self.browser_page(browser) as page:
            dashboard_url, dashboard_tokens, _ = self.goto_with_json(
                page,
                self.config.target_url,
                ready_pattern=EZAICLUB_BALANCE_READY_PATTERN,
                min_wait_ms=2000,
            )
            balances = parse_ezaiclub_balance_tokens(dashboard_tokens)
            if not balances:
                dump_tokens(
                    self.config,
                    dashboard_tokens,
                    title=page.title(),
                    url=dashboard_url,
                    suffix="dashboard",
                )

            subscription_metrics = self.fetch_subscription_metrics(page)
            monitors, groups, rates, channel_error = self.fetch_channel_payloads(
                page,
                "/api/v1/groups/available",
                timezone_name="Asia/Shanghai",
            )
            channels = None if channel_error else parse_ezaiclub_channels(self.config, monitors, groups, rates)
            return ezaiclub_snapshot(
                self.config,
                dashboard_url=dashboard_url if "/subscriptions" not in dashboard_url else self.config.target_url,
                balances=balances,
                subscription_metrics=subscription_metrics,
                channels=channels,
                channel_error=channel_error,
            )

    def fetch_subscription_metrics(self, page) -> list[dict[str, Any]]:
        subscription_url = next(
            (
                item["url"]
                for item in self.config.secondary_urls or []
                if "subscription" in item["url"]
            ),
            DEFAULT_EZAICLUB_SUBSCRIPTIONS_URL,
        )
        try:
            page_url, tokens, _ = self.goto_with_json(
                page,
                subscription_url,
                ready_pattern=EZAICLUB_SUBSCRIPTION_READY_PATTERN,
                min_wait_ms=2500,
                timeout_ms=24000,
            )
            metrics = parse_ezaiclub_subscription_tokens(tokens)
            if not metrics:
                dump_tokens(
                    self.config,
                    tokens,
                    title=page.title(),
                    url=page_url,
                    suffix="subscriptions",
                )
            return metrics
        except NotLoggedInError:
            raise
        except Exception:
            return []


class SiliconFlowProvider(BrowserJsonProvider):
    login_hints = SILICONFLOW_LOGIN_HINTS
    login_error = "BrowserOS profile is not logged in to SiliconFlow"
    default_host = "cloud.siliconflow.cn"
    ready_pattern = SILICONFLOW_READY_PATTERN

    def fetch(
        self,
        refresh_auth: bool = False,
        browser_fallback: bool = True,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        with self.browser_page(browser) as page:
            page_url, tokens, _ = self.goto_with_json(
                page,
                self.config.target_url,
                ready_pattern=SILICONFLOW_READY_PATTERN,
                min_wait_ms=1500,
            )
            balances = parse_siliconflow_balance_tokens(tokens)
            metrics = parse_siliconflow_metric_tokens(tokens)
            if not balances and not metrics:
                dump_tokens(
                    self.config,
                    tokens,
                    title=page.title(),
                    url=page_url,
                    suffix="coupon",
                )
            return siliconflow_snapshot(self.config, page_url, balances, metrics)


PROVIDER_TYPES: dict[str, type[Provider]] = {
    "page": GenericPageProvider,
    "opencode": OpenCodeProvider,
    "deepseek": DeepSeekProvider,
    "ezaiclub": EZAICLUBProvider,
    "siliconflow": SiliconFlowProvider,
    "newapi": NewAPIProvider,
    "sub2api": Sub2APIProvider,
}


def is_api_provider(config: ProviderConfig) -> bool:
    return config.mode == "api" or config.type == "deepseek"


class ProviderManager:
    def __init__(
        self,
        configs: list[ProviderConfig] | None = None,
        cache_file: Path = CACHE_FILE,
    ) -> None:
        self.configs = configs if configs is not None else load_config()
        self.cache_file = cache_file
        self.cache: dict[str, Any] = self.load_cache()
        self._lock = threading.RLock()

    def enabled_configs(self) -> list[ProviderConfig]:
        with self._lock:
            return [config for config in self.configs if config.enabled]

    def replace_configs(self, configs: list[ProviderConfig]) -> list[ProviderConfig]:
        with self._lock:
            self.configs = list(configs)
            valid_ids = {config.id for config in configs}
            cached = self.cache.setdefault("providers", {})
            self.cache["providers"] = {
                provider_id: snapshot
                for provider_id, snapshot in cached.items()
                if provider_id in valid_ids
            }
            self.save_cache()
            return list(self.configs)

    def get_provider(self, provider_id: str) -> Provider:
        config = next((item for item in self.configs if item.id == provider_id), None)
        if not config:
            raise KeyError(f"unknown provider: {provider_id}")
        provider_class = PROVIDER_TYPES.get(config.type)
        if provider_class:
            return provider_class(config)
        raise ValueError(f"unsupported provider type: {config.type}")

    def load_cache(self) -> dict[str, Any]:
        if not self.cache_file.exists():
            return {"providers": {}}
        try:
            data = json.loads(self.cache_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"providers": {}}
        if not isinstance(data, dict) or not isinstance(data.get("providers"), dict):
            return {"providers": {}}
        return data

    def save_cache(self) -> None:
        with self._lock:
            self.cache_file.write_text(
                json.dumps(self.cache, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    def list_snapshots(self) -> list[dict[str, Any]]:
        with self._lock:
            providers = self.cache.setdefault("providers", {})
            rows = []
            for config in self.enabled_configs():
                cached = providers.get(config.id)
                if cached:
                    rows.append(cached)
                else:
                    rows.append(blank_snapshot(config))
            return rows

    def refresh(
        self,
        provider_id: str,
        browser: BrowserSession | None = None,
    ) -> dict[str, Any]:
        provider = self.get_provider(provider_id)
        with self._lock:
            providers = self.cache.setdefault("providers", {})
            previous = providers.get(provider_id)
        try:
            snapshot = provider.fetch(browser=browser)
        except Exception as exc:
            config = provider.config
            stale_metrics = previous.get("metrics", []) if previous else []
            stale_balances = previous.get("balances", []) if previous else []
            stale_usage = previous.get("usage", []) if previous else []
            snapshot = {
                "id": config.id,
                "name": config.name,
                "type": config.type,
                "status": "error" if not (stale_metrics or stale_balances or stale_usage) else "stale",
                "url": config.target_url,
                "updated_at": previous.get("updated_at") if previous else None,
                "checked_at": now_iso(),
                "subscribed": previous.get("subscribed") if previous else None,
                "balances": stale_balances,
                "usage": stale_usage,
                "metrics": stale_metrics,
                "links": previous.get("links", links_for_config(config)) if previous else links_for_config(config),
                "recommendation": previous.get("recommendation", "watch") if previous else "watch",
                "error": str(exc),
            }
        if snapshot.get("channels") is None:
            previous_channels = previous.get("channels", []) if previous else []
            snapshot["channels"] = previous_channels
            snapshot["channelCheckedAt"] = previous.get("channelCheckedAt") if previous else None
            snapshot["channelsStale"] = bool(previous_channels)
        with self._lock:
            self.cache.setdefault("providers", {})[provider_id] = snapshot
            self.save_cache()
        return snapshot

    def refresh_all(self) -> list[dict[str, Any]]:
        """Refresh API providers in parallel; reuse one browser per profile for the rest."""
        enabled = self.enabled_configs()
        results: dict[str, dict[str, Any]] = {}
        api_ids = [config.id for config in enabled if is_api_provider(config)]
        browser_groups: dict[str, list[str]] = {}
        for config in enabled:
            if is_api_provider(config):
                continue
            browser_groups.setdefault(config.profile_dir, []).append(config.id)

        max_workers = max(1, len(api_ids))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(self.refresh, provider_id): provider_id for provider_id in api_ids}
            for profile_dir, provider_ids in browser_groups.items():
                with BrowserSession(profile_dir) as session:
                    for provider_id in provider_ids:
                        results[provider_id] = self.refresh(provider_id, browser=session)
            for future in as_completed(futures):
                provider_id = futures[future]
                results[provider_id] = future.result()

        return [results[config.id] for config in enabled]

    def refresh_channels(self) -> list[dict[str, Any]]:
        channel_configs = [
            config for config in self.enabled_configs()
            if config.type in {"ezaiclub", "sub2api"}
        ]
        results = []
        browser_groups: dict[str, list[str]] = {}
        for config in channel_configs:
            browser_groups.setdefault(config.profile_dir, []).append(config.id)
        for profile_dir, provider_ids in browser_groups.items():
            with BrowserSession(profile_dir) as session:
                for provider_id in provider_ids:
                    results.append(self.refresh(provider_id, browser=session))
        return results

    def explore(self, provider_id: str) -> Path:
        return self.get_provider(provider_id).explore()
