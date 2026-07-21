#!/usr/bin/env python3
"""Provider collectors for local quota/usage dashboard."""

from __future__ import annotations

import json
import os
import re
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
DEFAULT_OPENCODE_URL = (
    "https://opencode.ai/workspace/wrk_01KW9MTABWQ0DNJ014CV528WC2/go"
)
DEFAULT_DEEPSEEK_URL = "https://platform.deepseek.com/usage"
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"

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
    r"invoice|balance|余额|消耗|充值|模型",
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
    mode: str = "browser"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProviderConfig":
        profile_dir = str(data.get("profile_dir") or DEFAULT_PROFILE_DIR)
        cookie_cache = data.get("cookie_cache")
        return cls(
            id=str(data["id"]),
            name=str(data.get("name") or data["id"]),
            type=str(data["type"]),
            target_url=str(data["target_url"]),
            enabled=bool(data.get("enabled", True)),
            profile_dir=os.path.expanduser(profile_dir),
            cookie_cache=os.path.expanduser(str(cookie_cache)) if cookie_cache else None,
            api_key_env=str(data.get("api_key_env")) if data.get("api_key_env") else None,
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

    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        profile_dir,
        executable_path=BROWSEROS_BIN,
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    return pw, context


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
        if item.get("key") == "total_balance"
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


def dump_tokens(config: ProviderConfig, tokens: list[str], title: str, url: str) -> Path:
    DEFAULT_DUMP_DIR.mkdir(parents=True, exist_ok=True)
    path = DEFAULT_DUMP_DIR / f"{config.id}.txt"
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
        if config.type == "opencode":
            return OpenCodeProvider(config)
        if config.type == "deepseek":
            return DeepSeekProvider(config)
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
