import unittest
from datetime import datetime, timezone

from channels import (
    effective_group_rate,
    list_channels,
    parse_ezaiclub_channels,
    parse_sub2api_channels,
    rank_available_channels,
    summarize_channel_refresh,
)


class ChannelTests(unittest.TestCase):
    def test_sub2api_channels_match_and_rank(self):
        config = {
            "id": "fastaitoken",
            "name": "FastAIToken",
            "targetUrl": "https://www.fastaitoken.com/dashboard",
            "rechargeRatio": 1,
        }
        groups = {"data": [{
            "name": "OpenAI",
            "platforms": [{
                "platform": "openai",
                "groups": [
                    {"id": 4, "name": "[0.25x]OpenAI backup", "platform": "openai", "rate_multiplier": 0.25},
                    {"id": 21, "name": "[0.06x]OpenAI welfare", "platform": "openai", "rate_multiplier": 0.06},
                ],
                "supported_models": [{"name": "gpt-5.6-sol"}],
            }],
        }]}
        monitors = {"data": {"items": [
            {
                "id": 4,
                "name": "[0.25x]OpenAI backup",
                "provider": "openai",
                "primary_model": "gpt-5.6-sol",
                "primary_status": "operational",
                "primary_latency_ms": 3184,
                "availability_7d": 95.12,
            },
            {
                "id": 6,
                "name": "[0.06x]OpenAI welfare",
                "provider": "openai",
                "primary_model": "gpt-5.6-sol",
                "primary_status": "operational",
                "primary_latency_ms": 1628,
                "availability_7d": 68.73,
                "timeline": [{"status": "operational", "checked_at": "2026-08-03T10:12:00Z"}],
            },
        ]}}
        channels = parse_sub2api_channels(config, monitors, groups, {"data": {}})
        ranked = rank_available_channels([{
            "id": "fastaitoken",
            "status": "ok",
            "balances": [{"key": "balance", "value": "7.70"}],
            "channels": channels,
        }], "gpt-5.6-sol")
        self.assertEqual([channel["groupId"] for channel in channels], [4, 21])
        self.assertEqual(ranked[0]["monitorId"], 6)
        self.assertEqual(ranked[0]["effectiveMultiplier"], 0.06)

    def test_ezaiclub_recharge_ratio(self):
        config = {
            "id": "ezaiclub",
            "name": "EZAICLUB",
            "targetUrl": "https://www.ezaiclub.com/dashboard",
            "rechargeRatio": 10,
        }
        monitors = {"data": {"items": [{
            "id": 12,
            "name": "gpt-5.6 special",
            "provider": "openai",
            "primary_model": "gpt-5.6-sol",
            "primary_status": "operational",
        }]}}
        groups = {"data": [{
            "id": 50,
            "name": "general OpenAI gpt-5.6 special pool",
            "platform": "openai",
            "rate_multiplier": 1,
        }]}
        [channel] = parse_ezaiclub_channels(config, monitors, groups, {"data": {}})
        self.assertEqual(channel["groupId"], 50)
        self.assertEqual(channel["listedEffectiveMultiplier"], 1)
        self.assertEqual(channel["effectiveMultiplier"], 0.1)

    def test_peak_rate_crosses_midnight(self):
        rate = effective_group_rate({
            "id": 1,
            "rate_multiplier": 0.2,
            "peak_rate_enabled": True,
            "peak_start": "23:00",
            "peak_end": "02:00",
            "peak_rate_multiplier": 0.4,
        }, now=datetime(2026, 8, 2, 16, 30, tzinfo=timezone.utc))
        self.assertTrue(rate["peakActive"])
        self.assertEqual(rate["effectiveMultiplier"], 0.4)

    def test_channel_summary_ignores_non_channel_providers(self):
        summary = summarize_channel_refresh([
            {"id": "deepseek", "type": "deepseek", "status": "error", "channels": []},
            {"id": "sub2api", "type": "sub2api", "status": "ok", "channels": [{"id": 1}]},
        ])
        self.assertEqual(summary, {
            "providerCount": 1,
            "channelCount": 1,
            "unrankedCount": 1,
            "failedCount": 0,
            "latestCheckedAt": None,
        })

    def test_channel_listing_keeps_error_and_unknown_rate_channels(self):
        channels = parse_sub2api_channels(
            {"id": "fast", "name": "Fast", "targetUrl": "https://fast.example/"},
            {
                "data": {"items": [
                    {"id": 1, "name": "可用", "provider": "openai", "primary_model": "gpt", "primary_status": "operational"},
                    {"id": 2, "name": "故障", "provider": "openai", "primary_model": "gpt", "primary_status": "error"},
                ]}
            },
            {"data": []},
        )
        listed = list_channels([{"id": "fast", "status": "ok", "channels": channels}])
        self.assertEqual([item["monitorId"] for item in listed], [1, 2])
        self.assertEqual(list_channels([{"id": "fast", "status": "ok", "channels": channels}], statuses=["error"])[0]["monitorId"], 2)
        self.assertEqual(list_channels([{"id": "fast", "status": "ok", "channels": channels}], rate_mode="unknown")[0]["monitorId"], 1)


if __name__ == "__main__":
    unittest.main()
