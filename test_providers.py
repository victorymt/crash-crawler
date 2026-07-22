import tempfile
import unittest
from pathlib import Path

from providers import (
    DeepSeekProvider,
    EZAICLUBProvider,
    ProviderConfig,
    ProviderManager,
    SiliconFlowProvider,
    parse_deepseek_balance,
    parse_ezaiclub_balance_tokens,
    parse_ezaiclub_subscription_tokens,
    parse_opencode_legacy,
    parse_percent,
    parse_siliconflow_balance_tokens,
    parse_siliconflow_metric_tokens,
    sync_browseros_profile,
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
        ]
        manager = ProviderManager(configs=configs)

        self.assertIsInstance(manager.get_provider("deepseek"), DeepSeekProvider)
        self.assertIsInstance(manager.get_provider("ezaiclub"), EZAICLUBProvider)
        self.assertIsInstance(manager.get_provider("siliconflow"), SiliconFlowProvider)

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
            target.mkdir()
            (target / "SingletonSocket").write_text("target-lock", encoding="utf-8")

            result = sync_browseros_profile(source, target)

            self.assertTrue(result["ok"])
            self.assertEqual((target / "Cookies").read_text(encoding="utf-8"), "cookie-db")
            self.assertFalse((target / "SingletonLock").exists())
            self.assertFalse((target / "SingletonSocket").exists())

    def test_sync_browseros_profile_rejects_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(Exception):
                sync_browseros_profile(root / "missing", root / "target")


if __name__ == "__main__":
    unittest.main()
