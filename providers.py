#!/usr/bin/env python3
"""Provider collectors for local quota/usage dashboard."""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from http.cookiejar import Cookie, CookieJar
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlparse, urlunparse
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

BROWSEROS_BIN = os.environ.get("BROWSEROS_BIN", "/usr/bin/browseros")
DEFAULT_PROFILE_DIR = os.environ.get(
    "BROWSEROS_PROFILE_DIR", "/home/cv/.browseros-crawler-profile"
)
BROWSEROS_SOURCE_PROFILE_DIR = os.environ.get(
    "BROWSEROS_SOURCE_PROFILE_DIR", "/home/cv/.config/browser-os"
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
SILICONFLOW_LOGIN_HINTS = (
    "account.siliconflow.cn/login",
    "硅基流动统一登录",
    "Accelerate AGI to Benefit Humanity",
    "Blazing-fast, cost-effective Generative AI cloud services",
    "SiliconFlow Ambassador Program",
)
OPENCODE_USAGE_TYPES = ("滚动用量", "每周用量", "每月用量")


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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProviderConfig":
        profile_dir = str(data.get("profile_dir") or DEFAULT_PROFILE_DIR)
        cookie_cache = data.get("cookie_cache")
        secondary_urls = []
        for item in data.get("secondary_urls", []):
            if isinstance(item, str):
                secondary_urls.append({"label": "打开详情页", "url": item})
            elif isinstance(item, dict) and item.get("url"):
                secondary_urls.append(
                    {
                        "label": str(item.get("label") or "打开详情页"),
                        "url": str(item["url"]),
                    }
                )
        return cls(
            id=str(data["id"]),
            name=str(data.get("name") or data["id"]),
            type=str(data["type"]),
            target_url=str(data["target_url"]),
            enabled=bool(data.get("enabled", True)),
            profile_dir=os.path.expanduser(profile_dir),
            cookie_cache=os.path.expanduser(str(cookie_cache)) if cookie_cache else None,
            api_key_env=str(data.get("api_key_env")) if data.get("api_key_env") else None,
            secondary_urls=secondary_urls,
            mode=str(data.get("mode") or "browser"),
        )


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


def build_browser(profile_dir: str):
    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as exc:
        raise ProviderError(
            "Playwright is not installed in this uv environment. "
            "Run `UV_CACHE_DIR=/tmp/uv-cache uv pip install playwright`, "
            "then retry with `uv run python ...`."
        ) from exc

    profile_path = Path(profile_dir).expanduser()
    if profile_path.resolve() == Path(DEFAULT_PROFILE_DIR).expanduser().resolve():
        for name in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
            try:
                (profile_path / name).unlink()
            except FileNotFoundError:
                pass

    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        profile_dir,
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


def sync_browseros_profile(
    source_dir: str | Path = BROWSEROS_SOURCE_PROFILE_DIR,
    target_dir: str | Path = DEFAULT_PROFILE_DIR,
) -> dict[str, Any]:
    source = Path(source_dir).expanduser()
    target = Path(target_dir).expanduser()
    if not source.exists() or not source.is_dir():
        raise ProviderError(f"BrowserOS source profile not found: {source}")
    if source.resolve() == target.resolve():
        raise ProviderError("BrowserOS source and target profiles must be different")

    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    remove_profile_singletons(target)
    shutil.copytree(
        source,
        target,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("SingletonCookie", "SingletonLock", "SingletonSocket"),
    )
    remove_profile_singletons(target)
    return {
        "ok": True,
        "source": str(source),
        "target": str(target),
        "synced_at": now_iso(),
    }


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


def links_for_config(config: ProviderConfig) -> list[dict[str, str]]:
    return [
        {"label": "打开官方页面", "url": config.target_url},
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
        "links": links_for_config(config),
        "recommendation": "watch" if status in ("error", "unconfigured") else "ok",
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
        "links": links_for_config(config),
        "recommendation": recommendation_from_balances(balances),
        "error": None if metrics else "EZAICLUB pages loaded, but no balance or subscription fields were recognized",
        "raw": {
            "balance_count": len(balances),
            "subscription_metric_count": len(subscription_metrics),
        },
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

    def fetch(self, refresh_auth: bool = False, browser_fallback: bool = True) -> dict[str, Any]:
        raise NotImplementedError

    def explore(self) -> Path:
        pw, context = build_browser(self.config.profile_dir)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1000)
            return dump_tokens(self.config, page_tokens(page), page.title(), page.url)
        finally:
            context.close()
            pw.stop()


class BrowserJsonProvider(Provider):
    login_hints: tuple[str, ...] = ()
    login_error = "BrowserOS profile is not logged in"
    default_host = ""

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
        settle_ms: int = 3000,
    ) -> tuple[str, list[str], list[dict[str, Any]]]:
        responses: list[dict[str, Any]] = []
        self.capture_json_responses(page, responses, host)
        page.goto(url, wait_until="networkidle", timeout=timeout)
        page.wait_for_timeout(settle_ms)
        body_text = page.inner_text("body")
        login_probe = page.title() + "\n" + body_text
        if is_login_html(page.url, login_probe, self.login_hints):
            raise NotLoggedInError(self.login_error)
        tokens = [line.strip() for line in body_text.splitlines() if line.strip()]
        tokens.extend(extract_json_payloads(responses))
        return page.url, tokens, responses

    def with_browser_page(self):
        pw, context = build_browser(self.config.profile_dir)
        page = context.pages[0] if context.pages else context.new_page()
        return pw, context, page


class OpenCodeProvider(Provider):
    def fetch(self, refresh_auth: bool = False, browser_fallback: bool = True) -> dict[str, Any]:
        if not self.config.cookie_cache:
            raise MissingCookieError("opencode cookie_cache is not configured")

        try:
            cookies = self.refresh_cookies() if refresh_auth else load_cookie_cache(self.config.cookie_cache)
            html, url = request_html(self.config.target_url, cookies, OPENCODE_LOGIN_HINTS)
            legacy = parse_opencode_legacy(html_tokens(html), url)
            legacy["balances"] = self.fetch_balances(cookies)
            return opencode_snapshot(self.config, legacy)
        except (MissingCookieError, NotLoggedInError):
            if refresh_auth:
                raise
            try:
                cookies = self.refresh_cookies()
                html, url = request_html(self.config.target_url, cookies, OPENCODE_LOGIN_HINTS)
                legacy = parse_opencode_legacy(html_tokens(html), url)
                legacy["balances"] = self.fetch_balances(cookies)
                return opencode_snapshot(self.config, legacy)
            except Exception:
                if not browser_fallback:
                    raise
                return self.browser_fetch()
        except Exception:
            if not browser_fallback:
                raise
            return self.browser_fetch()

    def refresh_cookies(self) -> list[dict[str, Any]]:
        host = urlparse(self.config.target_url).hostname or "opencode.ai"
        pw, context = build_browser(self.config.profile_dir)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1000)
            html = page.content()
            if is_login_html(page.url, html, OPENCODE_LOGIN_HINTS):
                raise NotLoggedInError("BrowserOS profile is not logged in to opencode.ai")
            return save_cookie_cache(self.config.cookie_cache or "", context.cookies(self.config.target_url), host)
        finally:
            context.close()
            pw.stop()

    def fetch_balances(self, cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
        billing_url = derive_opencode_billing_url(self.config.target_url)
        try:
            html, _ = request_html(billing_url, cookies, OPENCODE_LOGIN_HINTS)
            balances = parse_opencode_balance_tokens(html_tokens(html))
        except Exception:
            return []
        if not balances:
            dump_tokens(
                self.config,
                html_tokens(html),
                title=f"{self.config.name} Billing",
                url=billing_url,
            )
        return balances

    def browser_fetch(self) -> dict[str, Any]:
        pw, context = build_browser(self.config.profile_dir)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(self.config.target_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1000)
            html = page.content()
            if is_login_html(page.url, html, OPENCODE_LOGIN_HINTS):
                raise NotLoggedInError("BrowserOS profile is not logged in to opencode.ai")
            legacy = parse_opencode_legacy(page_tokens(page), page.url)
            legacy["balances"] = self.browser_billing_balances(page)
            return opencode_snapshot(self.config, legacy)
        finally:
            context.close()
            pw.stop()

    def browser_billing_balances(self, page) -> list[dict[str, Any]]:
        billing_url = derive_opencode_billing_url(self.config.target_url)
        try:
            page.goto(billing_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1000)
            tokens = page_tokens(page)
            balances = parse_opencode_balance_tokens(tokens)
            if not balances:
                dump_tokens(self.config, tokens, title=page.title(), url=page.url)
            return balances
        except Exception:
            return []


class DeepSeekProvider(Provider):
    def fetch(self, refresh_auth: bool = False, browser_fallback: bool = True) -> dict[str, Any]:
        api_key_env = self.config.api_key_env or "DEEPSEEK_API_KEY"
        api_key = os.environ.get(api_key_env)
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


class EZAICLUBProvider(BrowserJsonProvider):
    login_hints = EZAICLUB_LOGIN_HINTS
    login_error = "BrowserOS profile is not logged in to EZAICLUB"
    default_host = "www.ezaiclub.com"

    def fetch(self, refresh_auth: bool = False, browser_fallback: bool = True) -> dict[str, Any]:
        pw, context, page = self.with_browser_page()
        try:
            dashboard_url, dashboard_tokens, _ = self.goto_with_json(page, self.config.target_url)
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
            return ezaiclub_snapshot(
                self.config,
                dashboard_url=dashboard_url if "/subscriptions" not in dashboard_url else self.config.target_url,
                balances=balances,
                subscription_metrics=subscription_metrics,
            )
        finally:
            context.close()
            pw.stop()

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
            page_url, tokens, _ = self.goto_with_json(page, subscription_url)
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

    def fetch(self, refresh_auth: bool = False, browser_fallback: bool = True) -> dict[str, Any]:
        pw, context, page = self.with_browser_page()
        try:
            page_url, tokens, _ = self.goto_with_json(page, self.config.target_url)
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
        finally:
            context.close()
            pw.stop()


PROVIDER_TYPES: dict[str, type[Provider]] = {
    "opencode": OpenCodeProvider,
    "deepseek": DeepSeekProvider,
    "ezaiclub": EZAICLUBProvider,
    "siliconflow": SiliconFlowProvider,
}


class ProviderManager:
    def __init__(
        self,
        configs: list[ProviderConfig] | None = None,
        cache_file: Path = CACHE_FILE,
    ) -> None:
        self.configs = configs if configs is not None else load_config()
        self.cache_file = cache_file
        self.cache: dict[str, Any] = self.load_cache()

    def enabled_configs(self) -> list[ProviderConfig]:
        return [config for config in self.configs if config.enabled]

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
        self.cache_file.write_text(
            json.dumps(self.cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def list_snapshots(self) -> list[dict[str, Any]]:
        providers = self.cache.setdefault("providers", {})
        rows = []
        for config in self.enabled_configs():
            cached = providers.get(config.id)
            if cached:
                rows.append(cached)
            else:
                rows.append(blank_snapshot(config))
        return rows

    def refresh(self, provider_id: str) -> dict[str, Any]:
        provider = self.get_provider(provider_id)
        providers = self.cache.setdefault("providers", {})
        previous = providers.get(provider_id)
        try:
            snapshot = provider.fetch()
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
        providers[provider_id] = snapshot
        self.save_cache()
        return snapshot

    def refresh_all(self) -> list[dict[str, Any]]:
        return [self.refresh(config.id) for config in self.enabled_configs()]

    def explore(self, provider_id: str) -> Path:
        return self.get_provider(provider_id).explore()
