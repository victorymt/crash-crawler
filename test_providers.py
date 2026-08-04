import tempfile
import threading
import unittest
from pathlib import Path

from providers import (
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
    sync_browseros_profile,
    wait_for_page_ready,
)


class ProviderParserTests(unittest.TestCase):
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

    def test_sync_browseros_profile_rejects_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(Exception):
                sync_browseros_profile(root / "missing", root / "target")

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
