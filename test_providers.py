import unittest

from providers import (
    ProviderConfig,
    parse_deepseek_balance,
    parse_ezaiclub_balance_tokens,
    parse_ezaiclub_subscription_tokens,
    parse_opencode_legacy,
    parse_percent,
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


if __name__ == "__main__":
    unittest.main()
