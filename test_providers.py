import json
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

from providers import (
    BrowserOSSession,
    DeepSeekProvider,
    EZAICLUBProvider,
    GenericPageProvider,
    NewAPIProvider,
    NotLoggedInError,
    ProviderConfig,
    ProviderManager,
    RefreshBusyError,
    SiliconFlowProvider,
    Sub2APIProvider,
    is_api_provider,
    evaluate_with_frame_retry,
    goto_with_frame_retry,
    install_provider_auth_session,
    persist_provider_auth_session,
    provider_auth_session_lock,
    parse_deepseek_balance,
    parse_ezaiclub_balance_tokens,
    parse_ezaiclub_subscription_tokens,
    parse_generic_page_tokens,
    parse_generic_selector_results,
    parse_opencode_legacy,
    parse_percent,
    parse_siliconflow_balance_tokens,
    parse_siliconflow_metric_tokens,
    profile_fingerprint,
    resolve_browser_executable,
    refresh_sub2api_auth_session,
    sync_browseros_auth_sessions,
    sync_browseros_profile,
    verify_provider_auth_session,
    wait_for_page_ready,
    is_transient_frame_error,
)
from provider_auth import ProviderAuthSessionError


class ProviderParserTests(unittest.TestCase):
    def test_browser_executable_prefers_config_then_system_chromium(self):
        with patch.dict("providers.os.environ", {"PROVIDER_BROWSER_BIN": "/custom/chromium"}, clear=True):
            self.assertEqual(resolve_browser_executable(), "/custom/chromium")

        with (
            patch.dict("providers.os.environ", {}, clear=True),
            patch("providers.shutil.which", side_effect=lambda name: "/usr/bin/chromium" if name == "chromium" else None),
        ):
            self.assertEqual(resolve_browser_executable(), "/usr/bin/chromium")

        with patch.dict("providers.os.environ", {"BROWSEROS_BIN": "/legacy/browser"}, clear=True):
            self.assertEqual(resolve_browser_executable(), "/legacy/browser")

    def test_provider_cache_save_is_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_file = Path(tmp) / "cache.json"
            original = {"providers": {"old": {"status": "ok"}}}
            cache_file.write_text(json.dumps(original), encoding="utf-8")
            manager = ProviderManager(configs=[], cache_file=cache_file)
            manager.cache = {"providers": {"new": {"status": "ok"}}}

            with patch("providers.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    manager.save_cache()

            self.assertEqual(json.loads(cache_file.read_text(encoding="utf-8")), original)
            self.assertEqual(list(Path(tmp).glob(".cache.json.*.tmp")), [])

            manager.save_cache()
            self.assertEqual(
                json.loads(cache_file.read_text(encoding="utf-8")),
                manager.cache,
            )
            self.assertEqual(list(Path(tmp).glob(".cache.json.*.tmp")), [])

    def test_parse_percent(self):
        self.assertEqual(parse_percent("35%"), 35)
        self.assertEqual(parse_percent(" 100% "), 100)
        self.assertIsNone(parse_percent("35"))

    def test_parse_opencode_dump_tokens(self):
        tokens = [
            "滚动用量",
            "23%",
            "重置于 3 小时 3 分钟",
            "每周用量",
            "19%",
            "重置于 6 天 7 小时",
            "每月用量",
            "96%",
            "重置于 8 天 19 小时",
        ]
        result = parse_opencode_legacy(tokens, "https://example.test")
        self.assertEqual(len(result["usage"]), 3)
        self.assertEqual(result["usage"][0]["percent"], "23%")
        self.assertEqual(result["usage"][2]["reset_in"], "8 天 19 小时")

    def test_parse_deepseek_balance(self):
        config = ProviderConfig(
            id="deepseek",
            name="DeepSeek",
            type="deepseek",
            target_url="https://platform.deepseek.com/usage",
        )
        result = parse_deepseek_balance(
            {
                "is_available": True,
                "balance_infos": [
                    {
                        "currency": "CNY",
                        "total_balance": "12.50",
                        "granted_balance": "2.50",
                        "topped_up_balance": "10.00",
                    }
                ],
            },
            config,
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["recommendation"], "ok")
        self.assertEqual(result["balances"][0]["label"], "总余额")
        self.assertEqual(result["balances"][0]["value"], "12.50")

    def test_parse_ezaiclub_balance_tokens(self):
        balances = parse_ezaiclub_balance_tokens(
            [
                "Dashboard",
                "账户余额",
                "¥ 88.60",
                "充值",
            ]
        )
        self.assertEqual(balances[0]["key"], "balance")
        self.assertEqual(balances[0]["value"], "88.60")
        self.assertEqual(balances[0]["currency"], "CNY")
        self.assertEqual(
            parse_ezaiclub_balance_tokens(["余额", "1", "$20.8356166"])[0]["value"],
            "20.84",
        )

    def test_parse_ezaiclub_subscription_tokens(self):
        metrics = parse_ezaiclub_subscription_tokens(
            [
                "Subscriptions",
                "当前套餐",
                "Pro Monthly",
                "到期时间",
                "2026-08-21",
            ]
        )
        self.assertTrue(metrics)
        self.assertEqual(metrics[0]["label"], "当前套餐")
        self.assertEqual(metrics[0]["value"], "Pro Monthly")
        usage = parse_ezaiclub_subscription_tokens(
            ["已达到 95%，但到期前没有可提前重置的窗口。", "2026/07/28"]
        )
        self.assertEqual(usage[0]["label"], "订阅用量")
        live_usage = parse_ezaiclub_subscription_tokens(
            [
                "Lite周卡",
                "OpenAI",
                "倍率: ×1.2",
                "已达到 95%，但到期前没有可提前重置的窗口。",
                "有效",
                "续费",
                "到期时间",
                "剩余 6天13小时 (2026/07/29 00:17)",
                "每周",
                "$50.15 / $50.00",
                "6天13小时 后重置",
            ]
        )
        self.assertEqual(live_usage[0]["label"], "每周用量")
        self.assertEqual(live_usage[0]["value"], "$50.15 / $50.00")
        self.assertEqual(live_usage[0]["percent"], 100)
        self.assertEqual(live_usage[0]["reset_in"], "6天13小时")
        self.assertEqual(live_usage[1]["label"], "到期时间")
        self.assertEqual(live_usage[1]["value"], "2026/07/29 00:17")
        self.assertFalse(any(item["label"] in {"有效", "续费"} for item in live_usage))
        api_usage = parse_ezaiclub_subscription_tokens(
            [
                "weekly_usage_usd",
                "50.1509256",
                "monthly_usage_usd",
                "100.5876372",
                "weekly_limit_usd",
                "50",
                "monthly_limit_usd",
                "0",
                "expires_at",
                "2026-07-29T00:17:57.582205+08:00",
            ]
        )
        self.assertEqual(api_usage[0]["label"], "每周用量")
        self.assertEqual(api_usage[0]["value"], "$50.15 / $50.00")
        self.assertEqual(api_usage[1]["label"], "到期时间")
        self.assertEqual(api_usage[1]["value"], "2026-07-29 00:17")
        combined_usage = parse_ezaiclub_subscription_tokens(
            [
                "weekly_usage_usd",
                "50.1509256",
                "weekly_limit_usd",
                "50",
                "每周",
                "$50.15 / $50.00",
                "6天13小时 后重置",
            ]
        )
        self.assertEqual(combined_usage[0]["reset_in"], "6天13小时")

    def test_parse_siliconflow_balance_tokens(self):
        balances = parse_siliconflow_balance_tokens(
            [
                "费用账单",
                "可用余额",
                "¥ 23.50",
                "优惠券",
                "10.00 CNY",
            ]
        )
        self.assertEqual(balances[0]["label"], "可用余额")
        self.assertEqual(balances[0]["value"], "23.50")
        self.assertEqual(balances[0]["currency"], "CNY")
        self.assertEqual(balances[1]["label"], "优惠券")
        self.assertEqual(balances[1]["value"], "10.00")

    def test_parse_siliconflow_json_tokens(self):
        balances = parse_siliconflow_balance_tokens(
            [
                "couponBalance",
                "3.456",
                "balance",
                "8.9",
                "currency",
                "CNY",
            ]
        )
        self.assertEqual({item["value"] for item in balances}, {"3.46", "8.90"})
        metrics = parse_siliconflow_metric_tokens(["有效期", "2026-08-21", "账单金额", "1.20"])
        self.assertEqual(metrics[0]["label"], "有效期")
        self.assertEqual(metrics[0]["value"], "2026-08-21")

    def test_provider_manager_registry(self):
        configs = [
            ProviderConfig(
                id="page",
                name="Page",
                type="page",
                target_url="https://page.example/dashboard",
                parser_rules={"balances": [{"id": "balance-1", "selector": ".balance"}]},
            ),
            ProviderConfig(
                id="deepseek",
                name="DeepSeek",
                type="deepseek",
                target_url="https://platform.deepseek.com/usage",
            ),
            ProviderConfig(
                id="ezaiclub",
                name="EZAICLUB",
                type="ezaiclub",
                target_url="https://www.ezaiclub.com/dashboard",
            ),
            ProviderConfig(
                id="siliconflow",
                name="SiliconFlow",
                type="siliconflow",
                target_url="https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
            ),
            ProviderConfig(
                id="newapi",
                name="New API",
                type="newapi",
                target_url="https://newapi.example/dashboard",
            ),
            ProviderConfig(
                id="sub2api",
                name="Sub2API",
                type="sub2api",
                target_url="https://sub2api.example/dashboard",
            ),
        ]
        manager = ProviderManager(configs=configs)

        self.assertIsInstance(manager.get_provider("page"), GenericPageProvider)
        self.assertIsInstance(manager.get_provider("deepseek"), DeepSeekProvider)
        self.assertIsInstance(manager.get_provider("ezaiclub"), EZAICLUBProvider)
        self.assertIsInstance(manager.get_provider("siliconflow"), SiliconFlowProvider)
        self.assertIsInstance(manager.get_provider("newapi"), NewAPIProvider)
        self.assertIsInstance(manager.get_provider("sub2api"), Sub2APIProvider)

    def test_sub2api_channel_group_endpoint_falls_back_to_groups_available(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.example/dashboard",
        )
        provider = Sub2APIProvider(config)
        requested = []

        class FakePage:
            def evaluate(self, _script, url):
                requested.append(url)
                if url.endswith("/api/v1/channel-monitors"):
                    return {"ok": True, "status": 200, "data": {"data": {"items": []}}}
                if url.endswith("/api/v1/channels/available"):
                    return {"ok": True, "status": 200, "data": {"data": []}}
                if url.endswith("/api/v1/groups/available"):
                    return {
                        "ok": True,
                        "status": 200,
                        "data": {"data": [{"id": 2, "platform": "openai", "rate_multiplier": 0.1}]},
                    }
                if url.endswith("/api/v1/groups/rates"):
                    return {"ok": True, "status": 200, "data": {"data": {}}}
                raise AssertionError(f"unexpected URL: {url}")

        monitors, groups, rates, error = provider.fetch_channel_payloads(
            FakePage(),
            ("/api/v1/channels/available", "/api/v1/groups/available"),
        )
        self.assertIsNone(error)
        self.assertEqual(groups["data"][0]["rate_multiplier"], 0.1)
        self.assertEqual(rates, {"data": {}})
        self.assertEqual(requested[1:3], [
            "https://fluxionai.example/api/v1/channels/available",
            "https://fluxionai.example/api/v1/groups/available",
        ])

    def test_newapi_provider_uses_authenticated_response_captured_during_load(self):
        config = ProviderConfig(
            id="newapi",
            name="New API",
            type="newapi",
            target_url="https://newapi.example/dashboard/overview",
        )
        provider = NewAPIProvider(config)
        responses = [
            {
                "url": "https://newapi.example/api/user/self",
                "status": 401,
                "data": {"success": False, "message": "unauthorized"},
            },
            {
                "url": "https://newapi.example/api/user/self?after-refresh=1",
                "status": 200,
                "data": {
                    "success": True,
                    "data": {
                        "username": "alice",
                        "quota": 2500000,
                        "used_quota": 500000,
                        "request_count": 12,
                    },
                },
            },
        ]

        class FakeBrowser:
            def page(self):
                return object()

        provider.goto_with_json = lambda *_args, **_kwargs: (
            config.target_url,
            [],
            responses,
        )

        def fail_direct_request(*_args, **_kwargs):
            raise AssertionError("captured authenticated response should avoid a direct API request")

        provider.page_api_json = fail_direct_request
        snapshot = provider.fetch(browser=FakeBrowser())

        self.assertEqual(snapshot["status"], "ok")
        self.assertEqual(snapshot["balances"][0]["value"], "5.00")
        self.assertEqual(snapshot["usage"][0]["value"], "$1.00 / $6.00")
        self.assertTrue(any(item.get("value") == "alice" for item in snapshot["metrics"]))

    def test_captured_json_response_reports_latest_unauthorized_response(self):
        provider = NewAPIProvider(ProviderConfig(
            id="newapi",
            name="New API",
            type="newapi",
            target_url="https://newapi.example/dashboard",
        ))
        with self.assertRaises(NotLoggedInError):
            provider.captured_json_response([
                {
                    "url": "https://newapi.example/api/user/self",
                    "status": 401,
                    "data": {"success": False},
                }
            ], "/api/user/self")

    def test_newapi_session_refresh_fallback_returns_self_payload(self):
        provider = NewAPIProvider(ProviderConfig(
            id="newapi",
            name="New API",
            type="newapi",
            target_url="https://newapi.example/dashboard",
        ))

        class FakePage:
            def evaluate(self, script, url):
                self.script = script
                self.url = url
                return {
                    "ok": True,
                    "status": 200,
                    "data": {"data": {"quota": 500000, "used_quota": 0}},
                }

        page = FakePage()
        payload = provider.page_api_json_with_session_refresh(
            page,
            "https://newapi.example/api/user/self",
        )

        self.assertEqual(payload["data"]["quota"], 500000)
        self.assertIn("/api/user/auth/refresh", page.script)
        self.assertIn("New-Api-User", page.script)
        self.assertEqual(page.url, "https://newapi.example/api/user/self")

    def test_provider_config_accepts_extension_field_names(self):
        config = ProviderConfig.from_dict({
            "id": "fastaitoken",
            "name": "FastAIToken",
            "type": "sub2api",
            "targetUrl": "https://www.fastaitoken.com/dashboard",
            "group": "常用",
            "rechargeRatio": 2,
            "secondaryUrls": [{"label": "监控", "url": "https://www.fastaitoken.com/monitor"}],
        })
        self.assertEqual(config.target_url, "https://www.fastaitoken.com/dashboard")
        self.assertEqual(config.group, "常用")
        self.assertEqual(config.recharge_ratio, 2)
        self.assertEqual(config.secondary_urls[0]["label"], "监控")

    def test_generic_page_rules_parse_tokens_and_selectors(self):
        token_result = parse_generic_page_tokens([
            "$74.84",
            "$50.15 / $50.00",
            "剩余 6天13小时 (2026/07/29 00:17)",
            "6天13小时 后重置",
        ], {
            "balances": [{"id": "balance", "label": "余额", "pattern": r"^[$](\d+(?:\.\d+)?)$", "currency": "USD"}],
            "quotas": [{
                "id": "quota", "label": "每周用量",
                "pattern": r"^[$](\d+(?:\.\d+)?)\s*/\s*[$](\d+(?:\.\d+)?)$",
                "currency": "USD", "resetPattern": r"(.+?)\s*后重置",
            }],
            "textMetrics": [{"id": "expires", "label": "到期时间", "pattern": r"剩余\s*[^()]*\(([^)]+)\)"}],
        })
        self.assertEqual(token_result["balances"][0]["value"], "74.84")
        self.assertEqual(token_result["usage"][0]["value"], "$50.15 / $50.00")
        self.assertEqual(token_result["usage"][0]["reset_in"], "6天13小时")
        self.assertEqual(token_result["textMetrics"][0]["value"], "2026/07/29 00:17")

        selector_result = parse_generic_selector_results({
            "balance-1": {"values": ["$12.34"], "matchCount": 1},
            "quota-1": {"values": ["$5 / $20"], "resetValues": ["3 天"], "matchCount": 1},
        }, {
            "balances": [{"id": "balance-1", "label": "余额", "selector": ".balance", "currency": "USD"}],
            "quotas": [{"id": "quota-1", "label": "额度", "selector": ".quota", "currency": "USD"}],
        })
        self.assertEqual(selector_result["balances"][0]["value"], "12.34")
        self.assertEqual(selector_result["usage"][0]["percent"], 25)

    def test_provider_manager_rejects_unknown_type(self):
        manager = ProviderManager(
            configs=[
                ProviderConfig(
                    id="unknown",
                    name="Unknown",
                    type="unknown",
                    target_url="https://example.test",
                )
            ]
        )
        with self.assertRaises(ValueError):
            manager.get_provider("unknown")

    def test_sync_browseros_profile_copies_files_and_removes_singletons(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "target"
            source.mkdir()
            (source / "Cookies").write_text("cookie-db", encoding="utf-8")
            (source / "SingletonLock").write_text("source-lock", encoding="utf-8")
            (source / "Cache" / "data").parent.mkdir()
            (source / "Cache" / "data").write_text("heavy", encoding="utf-8")
            target.mkdir()
            (target / "SingletonSocket").write_text("target-lock", encoding="utf-8")

            result = sync_browseros_profile(source, target)

            self.assertTrue(result["ok"])
            self.assertFalse(result.get("skipped"))
            self.assertEqual((target / "Cookies").read_text(encoding="utf-8"), "cookie-db")
            self.assertFalse((target / "SingletonLock").exists())
            self.assertFalse((target / "SingletonSocket").exists())
            self.assertFalse((target / "Cache").exists())

    def test_sync_browseros_profile_skips_unchanged_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "target"
            source.mkdir()
            (source / "Cookies").write_text("cookie-db", encoding="utf-8")

            first = sync_browseros_profile(source, target)
            second = sync_browseros_profile(source, target)

            self.assertTrue(first["ok"])
            self.assertFalse(first.get("skipped"))
            self.assertTrue(second["ok"])
            self.assertTrue(second.get("skipped"))
            self.assertEqual(profile_fingerprint(source)["source"], str(source.resolve()))

    def test_sync_browseros_profile_detects_and_copies_local_storage_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "target"
            storage = source / "Default" / "Local Storage" / "leveldb"
            storage.mkdir(parents=True)
            token_log = storage / "000003.log"
            token_log.write_text("before-login", encoding="utf-8")

            first = sync_browseros_profile(source, target)
            second = sync_browseros_profile(source, target)
            token_log.write_text("after-login-with-new-token", encoding="utf-8")
            third = sync_browseros_profile(source, target)

            self.assertFalse(first.get("skipped"))
            self.assertTrue(second.get("skipped"))
            self.assertFalse(third.get("skipped"))
            self.assertEqual(
                (target / "Default" / "Local Storage" / "leveldb" / "000003.log").read_text(
                    encoding="utf-8"
                ),
                "after-login-with-new-token",
            )

    def test_sync_browseros_profile_rejects_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(Exception):
                sync_browseros_profile(root / "missing", root / "target")

    def test_sync_browseros_auth_sessions_reads_only_matching_open_pages(self):
        fluxion = ProviderConfig(
            id="fluxionai",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        other = ProviderConfig(
            id="other-relay",
            name="Other Relay",
            type="sub2api",
            target_url="https://other.example/dashboard",
        )
        unsupported = ProviderConfig(
            id="generic",
            name="Generic",
            type="page",
            target_url="https://fluxionai.space/dashboard",
        )

        class FakePage:
            def __init__(self, url, session):
                self.url = url
                self.session = session
                self.arguments = []

            def is_closed(self):
                return False

            def evaluate(self, _script, argument=None):
                self.arguments.append(argument)
                return self.session

        fluxion_page = FakePage("https://fluxionai.space/console/keys", {
            "authToken": "live-access-token",
            "refreshToken": "live-refresh-token",
            "expiresAt": "123456",
        })
        unrelated_page = FakePage("https://attacker.example/dashboard", {
            "authToken": "attacker-token",
        })

        class FakeBrowser:
            contexts = [type("Context", (), {"pages": [fluxion_page, unrelated_page]})()]

        class FakeChromium:
            endpoint = ""

            def connect_over_cdp(self, endpoint, timeout):
                self.endpoint = endpoint
                self.timeout = timeout
                return FakeBrowser()

        class FakePlaywright:
            def __init__(self):
                self.chromium = FakeChromium()
                self.stopped = False

            def stop(self):
                self.stopped = True

        fake_playwright = FakePlaywright()
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"ports": {"cdp": 9144}}), encoding="utf-8")
            with (
                patch("providers._start_browseros_cdp_playwright", return_value=fake_playwright),
                patch("providers.save_provider_auth_session", return_value=True) as save_session,
                patch(
                    "providers.validate_sub2api_browser_session",
                    return_value=True,
                ) as validate_session,
            ):
                result = sync_browseros_auth_sessions(
                    [fluxion, other, unsupported], config_path=config_path
                )

        self.assertTrue(result["available"])
        self.assertEqual(result["eligible"], 2)
        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["synced"], 1)
        self.assertEqual(result["providers"], ["fluxionai"])
        self.assertEqual(fake_playwright.chromium.endpoint, "http://127.0.0.1:9144")
        self.assertTrue(fake_playwright.stopped)
        self.assertEqual(fluxion_page.arguments, ["https://fluxionai.space"])
        self.assertEqual(unrelated_page.arguments, [])
        self.assertEqual(result["mode"], "live_browseros")
        save_session.assert_not_called()
        validate_session.assert_called_once_with(fluxion_page, fluxion)
        self.assertNotIn("live-access-token", json.dumps(result))

    def test_browseros_session_reuses_existing_page_without_closing_it(self):
        class FakePage:
            url = "https://fluxionai.space/console/keys"

            def __init__(self):
                self.closed = False

            def is_closed(self):
                return self.closed

            def close(self):
                self.closed = True

        page = FakePage()
        context = type("Context", (), {"pages": [page]})()

        class FakeChromium:
            def connect_over_cdp(self, _endpoint, timeout):
                self.timeout = timeout
                return type("Browser", (), {"contexts": [context]})()

        class FakePlaywright:
            def __init__(self):
                self.chromium = FakeChromium()
                self.stopped = False

            def stop(self):
                self.stopped = True

        playwright = FakePlaywright()
        with (
            patch("providers.browseros_cdp_endpoint", return_value="http://127.0.0.1:9144"),
            patch("providers._start_browseros_cdp_playwright", return_value=playwright),
        ):
            with BrowserOSSession() as session:
                selected, created = session.page_for_url(
                    "https://fluxionai.space/dashboard"
                )
                session.release_page(selected)

        self.assertIs(selected, page)
        self.assertFalse(created)
        self.assertFalse(page.closed)
        self.assertTrue(playwright.stopped)

    def test_browseros_session_closes_only_its_temporary_page(self):
        class FakePage:
            url = "about:blank"

            def __init__(self):
                self.closed = False
                self.goto_urls = []

            def is_closed(self):
                return self.closed

            def goto(self, url, **_kwargs):
                self.goto_urls.append(url)
                self.url = url

            def close(self):
                self.closed = True

        page = FakePage()

        class FakeContext:
            pages = []

            def new_page(self):
                return page

        context = FakeContext()

        class FakeChromium:
            def connect_over_cdp(self, _endpoint, timeout):
                self.timeout = timeout
                return type("Browser", (), {"contexts": [context]})()

        class FakePlaywright:
            def __init__(self):
                self.chromium = FakeChromium()

            def stop(self):
                return None

        with (
            patch("providers.browseros_cdp_endpoint", return_value="http://127.0.0.1:9144"),
            patch(
                "providers._start_browseros_cdp_playwright",
                return_value=FakePlaywright(),
            ),
        ):
            with BrowserOSSession() as session:
                selected, created = session.page_for_url(
                    "https://fluxionai.space/dashboard"
                )
                self.assertFalse(selected.closed)

        self.assertTrue(created)
        self.assertEqual(page.goto_urls, ["https://fluxionai.space/dashboard"])
        self.assertTrue(page.closed)

    def test_browseros_session_keeps_login_page_open_for_the_user(self):
        class FakePage:
            def __init__(self):
                self.closed = False
                self.front = False

            def close(self):
                self.closed = True

            def bring_to_front(self):
                self.front = True

        page = FakePage()
        session = BrowserOSSession()
        session._created_pages.append(page)

        session.keep_page_open(page)
        session.close()

        self.assertTrue(page.front)
        self.assertFalse(page.closed)
        self.assertEqual(session._created_pages, [])

    def test_sync_browseros_auth_sessions_keeps_rejected_login_page_open(self):
        config = ProviderConfig(
            id="fluxionai",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )

        class FakePage:
            url = config.target_url

            def evaluate(self, _script, _argument=None):
                return {
                    "authToken": "rejected-access",
                    "refreshToken": "rejected-refresh",
                    "expiresAt": "123456",
                }

        page = FakePage()

        class FakeSession:
            def __init__(self, **_kwargs):
                self.kept = []
                self.released = []

            def start(self):
                return self

            def existing_pages_for_url(self, _url):
                return []

            def page_for_url(self, _url):
                return page, True

            def keep_page_open(self, selected):
                self.kept.append(selected)

            def release_page(self, selected):
                self.released.append(selected)

            def close(self):
                return None

        session = FakeSession()
        with (
            patch("providers.BrowserOSSession", return_value=session),
            patch(
                "providers.validate_sub2api_browser_session",
                side_effect=NotLoggedInError("SESSION_BINDING_MISMATCH"),
            ),
        ):
            result = sync_browseros_auth_sessions([config])

        self.assertEqual(session.kept, [page])
        self.assertEqual(session.released, [])
        self.assertEqual(result["synced"], 0)
        self.assertEqual(result["failures"][0]["id"], config.id)

    def test_sync_browseros_auth_sessions_reports_unavailable_cdp_without_secrets(self):
        config = ProviderConfig(
            id="fluxionai",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        with tempfile.TemporaryDirectory() as tmp:
            result = sync_browseros_auth_sessions(
                [config], config_path=Path(tmp) / "missing.json"
            )
        self.assertFalse(result["available"])
        self.assertEqual(result["synced"], 0)
        self.assertIn("configuration is unavailable", result["error"])

    def test_is_api_provider(self):
        api = ProviderConfig(
            id="deepseek",
            name="DeepSeek",
            type="deepseek",
            target_url="https://platform.deepseek.com/usage",
            mode="api",
        )
        browser = ProviderConfig(
            id="ezaiclub",
            name="EZAICLUB",
            type="ezaiclub",
            target_url="https://www.ezaiclub.com/dashboard",
            mode="browser",
        )
        self.assertTrue(is_api_provider(api))
        self.assertFalse(is_api_provider(browser))

    def test_wait_for_page_ready_returns_when_pattern_matches(self):
        class FakePage:
            def __init__(self):
                self.calls = 0

            def wait_for_load_state(self, *_args, **_kwargs):
                return None

            def wait_for_timeout(self, _ms):
                return None

            def inner_text(self, _selector):
                self.calls += 1
                if self.calls < 2:
                    return "loading..."
                return "账户余额 ¥ 12.00"

        text = wait_for_page_ready(
            FakePage(),
            ready_pattern=__import__("re").compile(r"账户余额"),
            timeout_ms=2000,
            min_wait_ms=0,
            poll_ms=1,
        )
        self.assertIn("账户余额", text)

    def test_transient_frame_error_is_classified_for_retry(self):
        self.assertTrue(is_transient_frame_error(Exception("Frame with ID 0 was removed.")))
        self.assertTrue(is_transient_frame_error(Exception("Execution context was destroyed.")))
        self.assertFalse(is_transient_frame_error(Exception("Page closed")))

    def test_frame_retry_recovers_evaluate_and_navigation(self):
        class FakePage:
            def __init__(self):
                self.evaluate_calls = 0
                self.goto_calls = 0
                self.reload_calls = 0

            def evaluate(self, _script, argument):
                self.evaluate_calls += 1
                if self.evaluate_calls == 1:
                    raise RuntimeError("Frame with ID 0 was removed.")
                return {"argument": argument}

            def goto(self, url, **_kwargs):
                self.goto_calls += 1
                if self.goto_calls == 1:
                    raise RuntimeError("Execution context was destroyed")
                return url

            def reload(self, **_kwargs):
                self.reload_calls += 1

        page = FakePage()
        self.assertEqual(evaluate_with_frame_retry(page, "() => 1", "value"), {"argument": "value"})
        self.assertEqual(goto_with_frame_retry(page, "https://example.test"), "https://example.test")
        self.assertEqual(page.reload_calls, 2)

    def test_provider_auth_session_is_injected_only_for_matching_provider(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )

        class FakePage:
            def __init__(self):
                self.script = ""

            def add_init_script(self, script):
                self.script = script

        page = FakePage()
        with patch("providers.load_local_secret", return_value=json.dumps({
            "authToken": "access-token",
            "refreshToken": "refresh-token",
            "expiresAt": "123",
        })):
            self.assertTrue(install_provider_auth_session(page, config))
        self.assertIn("access-token", page.script)
        self.assertIn("localStorage", page.script)
        self.assertIn("https://fluxionai.space", page.script)
        self.assertIn("location?.origin", page.script)

    def test_provider_auth_session_persists_rotated_tokens(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )

        class FakePage:
            argument = None

            def evaluate(self, _script, _argument=None):
                self.argument = _argument
                return {
                    "authToken": "rotated-access",
                    "refreshToken": "rotated-refresh",
                    "expiresAt": "654321",
                }

        page = FakePage()
        with patch("providers.set_local_secret") as save_secret:
            self.assertTrue(persist_provider_auth_session(page, config, {
                "authToken": "old-access",
                "refreshToken": "old-refresh",
                "expiresAt": "123456",
            }))
        self.assertEqual(page.argument, "https://fluxionai.space")
        secret_name, secret_value = save_secret.call_args.args
        self.assertEqual(secret_name, "provider_auth_session:fluxion")
        saved = json.loads(secret_value)
        self.assertEqual(saved["authToken"], "rotated-access")
        self.assertEqual(saved["refreshToken"], "rotated-refresh")
        self.assertTrue(saved["updatedAt"])

    def test_sub2api_auth_refresh_updates_page_storage_and_secret(self):
        config = ProviderConfig(
            id="sub2api-refresh",
            name="Sub2API Refresh",
            type="sub2api",
            target_url="https://relay.example/dashboard",
        )

        class FakePage:
            script = ""
            argument = None

            def evaluate(self, script, argument=None):
                self.script = script
                self.argument = argument
                return {
                    "refreshed": True,
                    "session": {
                        "authToken": "next-access",
                        "refreshToken": "next-refresh",
                        "expiresAt": "987654321",
                    },
                }

        page = FakePage()
        with patch("providers.set_local_secret") as save_secret:
            self.assertTrue(refresh_sub2api_auth_session(page, config, force=True))

        self.assertEqual(page.argument["origin"], "https://relay.example")
        self.assertTrue(page.argument["force"])
        self.assertGreater(page.argument["bufferMs"], 0)
        self.assertIn("/api/v1/auth/refresh", page.script)
        self.assertIn("payload?.success !== false", page.script)
        self.assertIn('localStorage?.setItem("refresh_token"', page.script)
        saved = json.loads(save_secret.call_args.args[1])
        self.assertEqual(saved["authToken"], "next-access")
        self.assertEqual(saved["refreshToken"], "next-refresh")

    def test_sub2api_verification_rejects_a_different_browseros_account(self):
        config = ProviderConfig(
            id="sub2api-account",
            name="Sub2API Account",
            type="sub2api",
            target_url="https://relay.example/dashboard",
        )

        class FakePage:
            def evaluate(self, _script, _argument=None):
                return {
                    "authToken": "bob-access",
                    "refreshToken": "bob-refresh",
                    "expiresAt": "9999999999999",
                    "authUser": json.dumps({"id": "84", "username": "bob"}),
                }

        stored = {
            "providerId": config.id,
            "origin": "https://relay.example",
            "userId": "42",
            "username": "alice",
            "authToken": "alice-access",
            "refreshToken": "alice-refresh",
            "updatedAt": "2020-01-01T00:00:00Z",
        }
        with (
            patch("providers.load_provider_auth_session", return_value=stored),
            patch("providers.save_provider_auth_session") as save_session,
            self.assertRaises(ProviderAuthSessionError) as raised,
        ):
            verify_provider_auth_session(
                FakePage(),
                config,
                {"data": {"id": "84", "username": "bob"}},
                persist=False,
            )
        self.assertEqual(raised.exception.code, "account_mismatch")
        save_session.assert_not_called()

    def test_sub2api_page_api_forces_refresh_after_unauthorized(self):
        config = ProviderConfig(
            id="sub2api-retry",
            name="Sub2API Retry",
            type="sub2api",
            target_url="https://relay.example/dashboard",
        )
        provider = Sub2APIProvider(config)
        page = object()
        with (
            patch(
                "providers.BrowserJsonProvider.page_api_json",
                side_effect=[NotLoggedInError("expired"), {"data": "ok"}],
            ) as request,
            patch("providers.refresh_sub2api_auth_session", return_value=True) as refresh,
        ):
            result = provider.page_api_json(page, "https://relay.example/api/v1/auth/me")

        self.assertEqual(result, {"data": "ok"})
        self.assertEqual(request.call_count, 2)
        refresh.assert_called_once_with(page, config, force=True)

    def test_sub2api_fetch_recovers_navigation_and_checks_expiry(self):
        config = ProviderConfig(
            id="sub2api-navigation-retry",
            name="Sub2API Navigation Retry",
            type="sub2api",
            target_url="https://relay.example/dashboard",
        )
        provider = Sub2APIProvider(config)
        page = object()
        auth_payload = {"data": {"username": "alice", "balance": 3.5}}
        with (
            patch.object(provider, "browser_page", return_value=nullcontext(page)),
            patch.object(
                provider,
                "goto_with_json",
                side_effect=[
                    NotLoggedInError("expired"),
                    (config.target_url, [], []),
                ],
            ) as navigate,
            patch.object(
                provider,
                "page_api_json",
                side_effect=[auth_payload, {"data": {"today_requests": 2}}],
            ),
            patch.object(
                provider,
                "fetch_channel_payloads",
                return_value=(None, None, None, "not collected"),
            ),
            patch(
                "providers.refresh_sub2api_auth_session",
                side_effect=[True, False],
            ) as refresh,
        ):
            snapshot = provider.fetch()

        self.assertEqual(navigate.call_count, 2)
        self.assertEqual(snapshot["status"], "ok")
        self.assertEqual(
            [call.kwargs for call in refresh.call_args_list],
            [{"force": True}, {}],
        )
        self.assertTrue(all(call.args == (page, config) for call in refresh.call_args_list))

    def test_sub2api_live_browseros_fetch_does_not_navigate_or_export_tokens(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        provider = Sub2APIProvider(config)
        page = type("Page", (), {"url": "https://fluxionai.space/console/keys"})()
        browser = type("Browser", (), {"is_live_browseros": True})()
        auth_payload = {"data": {"username": "alice", "balance": 3.5}}
        with (
            patch.object(provider, "browser_page", return_value=nullcontext(page)),
            patch.object(provider, "goto_with_json") as navigate,
            patch.object(
                provider,
                "page_api_json",
                side_effect=[auth_payload, {"data": {"today_requests": 2}}],
            ),
            patch.object(
                provider,
                "fetch_channel_payloads",
                return_value=(None, None, None, "not collected"),
            ),
            patch(
                "providers.refresh_sub2api_auth_session", return_value=False
            ) as refresh,
        ):
            snapshot = provider.fetch(browser=browser)

        navigate.assert_not_called()
        refresh.assert_called_once_with(page, config, persist=False)
        self.assertEqual(snapshot["status"], "ok")
        self.assertEqual(snapshot["url"], page.url)

    def test_live_browseros_login_failure_hands_temporary_page_to_user(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        provider = Sub2APIProvider(config)
        page = object()

        class FakeLiveSession:
            is_live_browseros = True

            def __init__(self):
                self.kept = []
                self.released = []

            def page_for_url(self, _url):
                return page, True

            def keep_page_open(self, selected):
                self.kept.append(selected)

            def release_page(self, selected):
                self.released.append(selected)

            def discard_page(self, _selected):
                return None

        browser = FakeLiveSession()
        with self.assertRaises(NotLoggedInError):
            with provider.browser_page(browser):
                raise NotLoggedInError("login required")

        self.assertEqual(browser.kept, [page])
        self.assertEqual(browser.released, [page])

    def test_provider_auth_session_lock_is_scoped_by_provider(self):
        self.assertIs(
            provider_auth_session_lock("provider-a"),
            provider_auth_session_lock("provider-a"),
        )
        self.assertIsNot(
            provider_auth_session_lock("provider-a"),
            provider_auth_session_lock("provider-b"),
        )

    def test_provider_auth_session_is_cleared_after_login_failure(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        provider = Sub2APIProvider(config)

        class FakePage:
            def add_init_script(self, _script):
                return None

            def close(self):
                return None

        class FakeContext:
            def new_page(self):
                return FakePage()

        class FakeBrowser:
            context = FakeContext()

        with (
            patch("providers.load_provider_auth_session", return_value={
                "authToken": "expired-access",
                "refreshToken": "expired-refresh",
            }),
            patch("providers.delete_local_secret") as delete_secret,
        ):
            with self.assertRaises(NotLoggedInError):
                with provider.browser_page(FakeBrowser()):
                    raise NotLoggedInError("login required")
        delete_secret.assert_called_once_with("provider_auth_session:fluxion")

    def test_provider_manager_classifies_login_failure(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )

        class FailingProvider:
            def __init__(self, provider_config):
                self.config = provider_config

            def fetch(self, browser=None):
                raise NotLoggedInError("login required")

        with tempfile.TemporaryDirectory() as tmp:
            manager = ProviderManager(configs=[config], cache_file=Path(tmp) / "cache.json")
            with patch.object(manager, "_provider_for_config", return_value=FailingProvider(config)):
                snapshot = manager._refresh_config(config)
        self.assertEqual(snapshot["status"], "needs_login")
        self.assertEqual(snapshot["channels"], [])

    def test_provider_manager_routes_sub2api_refresh_to_live_browseros(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        with tempfile.TemporaryDirectory() as tmp:
            manager = ProviderManager(
                configs=[config], cache_file=Path(tmp) / "cache.json"
            )

            class FakeLiveSession:
                is_live_browseros = True

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

            live_session = FakeLiveSession()
            expected = {"id": config.id, "status": "ok"}
            with (
                patch("providers.BrowserOSSession", return_value=live_session),
                patch.object(
                    manager, "_refresh_config", return_value=expected
                ) as refresh,
            ):
                result = manager.refresh(config.id)

        self.assertEqual(result, expected)
        refresh.assert_called_once_with(config, browser=live_session)

    def test_refresh_all_routes_sub2api_away_from_headless_session(self):
        config = ProviderConfig(
            id="fluxion",
            name="FluxionAI",
            type="sub2api",
            target_url="https://fluxionai.space/dashboard",
        )
        with tempfile.TemporaryDirectory() as tmp:
            manager = ProviderManager(
                configs=[config], cache_file=Path(tmp) / "cache.json"
            )

            class FakeLiveSession:
                is_live_browseros = True

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

            live_session = FakeLiveSession()
            seen = []

            def fake_refresh(current, browser=None):
                seen.append((current.id, browser))
                return {"id": current.id, "status": "ok"}

            manager._refresh_config = fake_refresh  # type: ignore[method-assign]
            with (
                patch("providers.BrowserOSSession", return_value=live_session),
                patch("providers.BrowserSession") as headless_session,
            ):
                result = manager.refresh_all()

        self.assertEqual(result, [{"id": "fluxion", "status": "ok"}])
        self.assertEqual(seen, [("fluxion", live_session)])
        headless_session.assert_not_called()

    def test_refresh_all_reuses_browser_session_and_runs_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_file = Path(tmp) / "cache.json"
            configs = [
                ProviderConfig(
                    id="deepseek",
                    name="DeepSeek",
                    type="deepseek",
                    target_url="https://platform.deepseek.com/usage",
                    mode="api",
                ),
                ProviderConfig(
                    id="ezaiclub",
                    name="EZAICLUB",
                    type="ezaiclub",
                    target_url="https://www.ezaiclub.com/dashboard",
                    mode="browser",
                    profile_dir=str(Path(tmp) / "profile"),
                ),
                ProviderConfig(
                    id="siliconflow",
                    name="SiliconFlow",
                    type="siliconflow",
                    target_url="https://cloud.siliconflow.cn/me/expensebill?tab=coupon",
                    mode="browser",
                    profile_dir=str(Path(tmp) / "profile"),
                ),
            ]
            manager = ProviderManager(configs=configs, cache_file=cache_file)
            seen_browsers = []

            def fake_refresh(config, browser=None):
                provider_id = config.id
                if provider_id != "deepseek":
                    seen_browsers.append(browser)
                snapshot = {
                    "id": provider_id,
                    "name": provider_id,
                    "type": provider_id,
                    "status": "ok",
                    "metrics": [],
                    "balances": [],
                    "usage": [],
                    "error": None,
                }
                manager.cache.setdefault("providers", {})[provider_id] = snapshot
                return snapshot

            manager._refresh_config = fake_refresh  # type: ignore[method-assign]
            sessions = []

            class FakeSession:
                def __init__(self, profile_dir):
                    self.profile_dir = profile_dir
                    sessions.append(self)

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

            import providers as providers_mod

            original = providers_mod.BrowserSession
            providers_mod.BrowserSession = FakeSession
            progress_events = []
            try:
                results = manager.refresh_all(
                    progress=lambda event, config, snapshot: progress_events.append(
                        (event, config.id, snapshot and snapshot.get("status"))
                    )
                )
            finally:
                providers_mod.BrowserSession = original

            self.assertEqual([item["id"] for item in results], ["deepseek", "ezaiclub", "siliconflow"])
            self.assertEqual(len(sessions), 1)
            self.assertEqual(seen_browsers[0], seen_browsers[1])
            self.assertIs(seen_browsers[0], sessions[0])
            self.assertEqual(
                {(event, provider_id) for event, provider_id, _ in progress_events},
                {
                    ("started", "deepseek"),
                    ("completed", "deepseek"),
                    ("started", "ezaiclub"),
                    ("completed", "ezaiclub"),
                    ("started", "siliconflow"),
                    ("completed", "siliconflow"),
                },
            )
            self.assertTrue(all(
                status == "ok"
                for event, _, status in progress_events
                if event == "completed"
            ))

    def test_refresh_all_skips_queued_providers_after_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            configs = [
                ProviderConfig(
                    id="first",
                    name="First",
                    type="page",
                    target_url="https://first.example.test",
                ),
                ProviderConfig(
                    id="second",
                    name="Second",
                    type="page",
                    target_url="https://second.example.test",
                ),
            ]
            manager = ProviderManager(configs=configs, cache_file=Path(tmp) / "cache.json")
            cancel_event = threading.Event()
            events = []

            def fake_refresh(current, browser=None):
                cancel_event.set()
                return {"id": current.id, "status": "ok", "error": None}

            manager._refresh_config = fake_refresh  # type: ignore[method-assign]
            import providers as providers_mod

            original = providers_mod.BrowserSession
            providers_mod.BrowserSession = type(
                "FakeSession",
                (),
                {
                    "__init__": lambda self, profile_dir: None,
                    "__enter__": lambda self: self,
                    "__exit__": lambda self, *_args: None,
                },
            )
            try:
                results = manager.refresh_all(
                    progress=lambda event, config, snapshot: events.append(
                        (event, config.id, snapshot and snapshot.get("status"))
                    ),
                    cancel_event=cancel_event,
                )
            finally:
                providers_mod.BrowserSession = original
            self.assertEqual([item["status"] for item in results], ["ok", "cancelled"])
            self.assertIn(("completed", "second", "cancelled"), events)

    def test_provider_manager_rejects_overlapping_refresh_operations(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = ProviderConfig(
                id="provider",
                name="Provider",
                type="page",
                target_url="https://example.test/dashboard",
            )
            manager = ProviderManager(
                configs=[config],
                cache_file=Path(tmp) / "cache.json",
            )
            started = threading.Event()
            release = threading.Event()

            def fake_refresh(current, browser=None):
                started.set()
                release.wait(timeout=2)
                return {"id": current.id, "status": "ok"}

            manager._refresh_config = fake_refresh  # type: ignore[method-assign]
            thread = threading.Thread(target=manager.refresh, args=(config.id,))
            thread.start()
            self.assertTrue(started.wait(timeout=1))
            try:
                with self.assertRaisesRegex(RefreshBusyError, "provider:provider"):
                    manager.refresh_channels()
            finally:
                release.set()
                thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def test_refresh_does_not_cache_result_after_provider_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = ProviderConfig(
                id="provider",
                name="Original",
                type="page",
                target_url="https://example.test/original",
            )
            updated = ProviderConfig(
                id="provider",
                name="Updated",
                type="page",
                target_url="https://example.test/updated",
            )
            manager = ProviderManager(
                configs=[original],
                cache_file=Path(tmp) / "cache.json",
            )
            started = threading.Event()
            release = threading.Event()
            result = {}

            class FakeProvider:
                def __init__(self, config):
                    self.config = config

                def fetch(self, browser=None):
                    started.set()
                    release.wait(timeout=2)
                    return {
                        "id": self.config.id,
                        "name": self.config.name,
                        "type": self.config.type,
                        "status": "ok",
                    }

            manager._provider_for_config = FakeProvider  # type: ignore[method-assign]

            def run_refresh():
                result.update(manager.refresh(original.id))

            thread = threading.Thread(target=run_refresh)
            thread.start()
            self.assertTrue(started.wait(timeout=1))
            manager.replace_configs([updated])
            release.set()
            thread.join(timeout=2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(result["name"], "Original")
            self.assertNotIn(original.id, manager.cache["providers"])
            self.assertEqual(manager.list_snapshots()[0]["name"], "Updated")


if __name__ == "__main__":
    unittest.main()
