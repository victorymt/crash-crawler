import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveGroupRate,
  parseEzaiclubChannels,
  parseSub2ApiChannels,
  rankAvailableChannels,
  summarizeChannelRefresh
} from "../extension/src/shared/channels.js";
import { preservePreviousChannels, snapshotNeedsRetry } from "../extension/src/shared/snapshots.js";

const config = {
  id: "fastaitoken",
  name: "FastAIToken",
  targetUrl: "https://www.fastaitoken.com/dashboard"
};

const availablePayload = {
  data: [
    {
      name: "Claude Max",
      platforms: [{
        platform: "anthropic",
        groups: [{ id: 1, name: "[1.5x倍率]Claude Max分组", platform: "anthropic", rate_multiplier: 1.5 }],
        supported_models: [{ name: "claude-opus-4-8" }]
      }]
    },
    {
      name: "Claude 普通分组/固定95%缓存",
      platforms: [{
        platform: "anthropic",
        groups: [{ id: 3, name: "[0.7x倍率][95%缓存]Claude普通分组", platform: "anthropic", rate_multiplier: 0.7 }],
        supported_models: [{ name: "claude-opus-4-8" }, { name: "claude-opus-4-6" }]
      }]
    },
    {
      name: "OpenAI Chatgpt",
      platforms: [{
        platform: "openai",
        groups: [
          { id: 2, name: "[0.25倍率][限时]OpenAI备用渠道", platform: "openai", rate_multiplier: 0.25 },
          { id: 4, name: "[0.2x倍率][限时]OpenAI 普通分组", platform: "openai", rate_multiplier: 0.2 },
          { id: 11, name: "[0.3x倍率][限时]OpenAI Pro线路", platform: "openai", rate_multiplier: 0.3 },
          { id: 21, name: "【限时】[0.06x]OpenAI 福利分组", platform: "openai", rate_multiplier: 0.06 }
        ],
        supported_models: [
          { name: "gpt-5.4-mini" },
          { name: "gpt-5.5" },
          { name: "gpt-5.6-sol" },
          { name: "gpt-5.6-terra" }
        ]
      }]
    }
  ]
};

const monitorsPayload = {
  data: {
    items: [
      {
        id: 8, name: "[1.5x]Claude Max 渠道", provider: "anthropic",
        primary_model: "claude-opus-4-8", primary_status: "error", primary_latency_ms: 30009,
        availability_7d: 83.68, extra_models: []
      },
      {
        id: 4, name: "[0.25x]OpenAI备用分组", provider: "openai",
        primary_model: "gpt-5.5", primary_status: "operational", primary_latency_ms: 3184,
        availability_7d: 95.12, extra_models: [{ model: "gpt-5.6-terra", status: "operational", latency_ms: 1566 }]
      },
      {
        id: 7, name: "[0.7x]Claude 普通分组", provider: "anthropic",
        primary_model: "claude-opus-4-8", primary_status: "operational", primary_latency_ms: 2644,
        availability_7d: 76.09, extra_models: [{ model: "claude-opus-4-6", status: "operational", latency_ms: 1521 }]
      },
      {
        id: 6, name: "【限时】[0.06x]OpenAI 福利分组", provider: "openai",
        primary_model: "gpt-5.5", primary_status: "operational", primary_latency_ms: 1628,
        availability_7d: 68.73, extra_models: [{ model: "gpt-5.6-sol", status: "operational", latency_ms: 2590 }],
        timeline: [
          { status: "operational", latency_ms: 1628, ping_latency_ms: 71, checked_at: "2026-08-03T10:12:00Z" },
          { status: "degraded", latency_ms: 8100, ping_latency_ms: 75, checked_at: "2026-08-03T10:09:00Z" },
          { status: "error", latency_ms: 30000, ping_latency_ms: 73, checked_at: "2026-08-03T10:06:00Z" }
        ]
      },
      {
        id: 5, name: "[0.3x]OpenAI Pro分组", provider: "openai",
        primary_model: "gpt-5.5", primary_status: "operational", primary_latency_ms: 1420,
        availability_7d: 98.98, extra_models: [{ model: "gpt-5.6-terra", status: "operational", latency_ms: 1656 }]
      },
      {
        id: 3, name: "[0.2x]OpenAI 普通分组", provider: "openai",
        primary_model: "gpt-5.5", primary_status: "operational", primary_latency_ms: 1863,
        availability_7d: 89.17, extra_models: [{ model: "gpt-5.6-terra", status: "operational", latency_ms: 1306 }]
      }
    ]
  }
};

function snapshot(channels) {
  return {
    id: config.id,
    status: "ok",
    balances: [{ key: "balance", value: "7.70" }],
    channels
  };
}

test("FastAIToken channels join to groups and rank the lowest operational multiplier", () => {
  const channels = parseSub2ApiChannels(config, monitorsPayload, availablePayload, { data: {} });
  assert.equal(channels.length, 6);
  assert.equal(channels.find((channel) => channel.monitorId === 6).groupId, 21);
  assert.equal(channels.find((channel) => channel.monitorId === 7).groupId, 3);

  const openAi = rankAvailableChannels([snapshot(channels)], "gpt-5.6-sol");
  assert.equal(openAi[0].monitorId, 6);
  assert.equal(openAi[0].effectiveMultiplier, 0.06);
  assert.equal(openAi[0].availability7d, 68.73);
  assert.deepEqual(openAi[0].timeline.map((point) => point.status), ["operational", "degraded", "error"]);
  assert.equal(openAi[0].timeline[0].checkedAt, "2026-08-03T10:12:00Z");

  const claude = rankAvailableChannels([snapshot(channels)], "claude-opus-4-8");
  assert.equal(claude.length, 1);
  assert.equal(claude[0].monitorId, 7);
  assert.equal(claude[0].effectiveMultiplier, 0.7);
});

test("EZAIClub flat groups match monitor names and convert 1:10 recharge rates", () => {
  const channels = parseEzaiclubChannels({
    id: "ezaiclub",
    name: "EZAICLUB",
    targetUrl: "https://www.ezaiclub.com/dashboard",
    rechargeRatio: 10
  }, {
    code: 0,
    data: {
      items: [
        {
          id: 7,
          name: "普通Grok号池",
          provider: "grok",
          primary_model: "grok-4.5",
          primary_status: "operational",
          primary_latency_ms: 2848,
          availability_7d: 91.4
        },
        {
          id: 6,
          name: "AWS逆向渠道",
          provider: "anthropic",
          primary_model: "claude-sonnet-5",
          primary_status: "operational",
          primary_latency_ms: 2537,
          availability_7d: 88.1
        },
        {
          id: 12,
          name: "特惠分组只有gpt-5.6[不稳定]",
          provider: "openai",
          primary_model: "gpt-5.6-sol",
          primary_status: "operational",
          primary_latency_ms: 2253,
          availability_7d: 61.7
        },
        {
          id: 2,
          name: "纯Pro20×号池[保99%]",
          provider: "openai",
          primary_model: "gpt-5.6-sol",
          primary_status: "operational",
          primary_latency_ms: 4019,
          availability_7d: 98.8
        }
      ]
    }
  }, {
    code: 0,
    data: [
      { id: 47, name: "通用余额[Grok-普通Grok号池]", platform: "grok", rate_multiplier: 0.2 },
      { id: 20, name: "通用余额[Claude-aws逆向渠道]", platform: "anthropic", rate_multiplier: 4.5 },
      { id: 50, name: "通用余额[OpenAI-gpt-5.6特惠号池]", platform: "openai", rate_multiplier: 1 },
      { id: 25, name: "通用余额[OpenAI-纯Pro号池]", platform: "openai", rate_multiplier: 1.8 }
    ]
  }, { data: {} });

  assert.deepEqual(channels.map((channel) => channel.groupId), [47, 20, 50, 25]);
  assert.deepEqual(channels.map((channel) => channel.listedEffectiveMultiplier), [0.2, 4.5, 1, 1.8]);
  assert.deepEqual(channels.map((channel) => channel.effectiveMultiplier), [0.02, 0.45, 0.1, 0.18]);
  assert.equal(channels.every((channel) => channel.rechargeRatio === 10), true);
  assert.equal(channels[0].monitorUrl, "https://www.ezaiclub.com/monitor");
  const ranked = rankAvailableChannels([snapshot(channels)], "gpt-5.6-sol");
  assert.equal(ranked[0].groupId, 50);
  assert.equal(ranked[0].effectiveMultiplier, 0.1);
});

test("channel recharge ratios are provider-configurable", () => {
  const [channel] = parseSub2ApiChannels(
    { ...config, rechargeRatio: 2 },
    { data: { items: [monitorsPayload.data.items[5]] } },
    availablePayload,
    { data: {} }
  );
  assert.equal(channel.listedEffectiveMultiplier, 0.2);
  assert.equal(channel.effectiveMultiplier, 0.1);
  assert.equal(channel.rechargeRatio, 2);
});

test("channel refresh summaries count channels and partial failures", () => {
  assert.deepEqual(summarizeChannelRefresh([
    { status: "ok", channels: [{}, {}] },
    { status: "ok", channels: [{}], channelError: "timeout", channelsStale: true },
    { status: "needs_visit", channels: [] }
  ]), {
    providerCount: 3,
    channelCount: 3,
    failedCount: 2
  });
});

test("user group rates override base rates without breaking monitor matching", () => {
  const channels = parseSub2ApiChannels(config, monitorsPayload, availablePayload, {
    data: { 4: 0.04, 21: 0.18 }
  });
  const ranked = rankAvailableChannels([snapshot(channels)], "gpt-5.5");
  assert.equal(ranked[0].groupId, 4);
  assert.equal(ranked[0].effectiveMultiplier, 0.04);
  assert.equal(ranked[0].rateSource, "user");

  const nullOverride = effectiveGroupRate({ id: 21, rate_multiplier: 0.06 }, { data: { 21: null } });
  assert.equal(nullOverride.effectiveMultiplier, 0.06);
  assert.equal(nullOverride.rateSource, "group");
});

test("peak rates use Asia/Shanghai time and support windows crossing midnight", () => {
  const daytime = effectiveGroupRate({
    id: 1,
    rate_multiplier: 0.2,
    peak_rate_enabled: true,
    peak_start: "09:00",
    peak_end: "10:00",
    peak_rate_multiplier: 0.5
  }, null, new Date("2026-08-03T01:30:00Z"));
  assert.equal(daytime.peakActive, true);
  assert.equal(daytime.effectiveMultiplier, 0.5);

  const overnight = effectiveGroupRate({
    id: 1,
    rate_multiplier: 0.2,
    peak_rate_enabled: true,
    peak_start: "23:00",
    peak_end: "02:00",
    peak_rate_multiplier: 0.4
  }, null, new Date("2026-08-02T16:30:00Z"));
  assert.equal(overnight.peakActive, true);
  assert.equal(overnight.effectiveMultiplier, 0.4);
});

test("partial channel failures retain previous data but exclude it from live ranking", () => {
  const previousChannels = parseSub2ApiChannels(config, monitorsPayload, availablePayload, { data: {} });
  const merged = preservePreviousChannels({
    id: config.id,
    status: "ok",
    balances: [{ key: "balance", value: "8.00" }],
    channels: null,
    channelError: "channel monitor timeout"
  }, {
    channels: previousChannels,
    channelCheckedAt: "2026-08-03T09:00:00Z"
  });
  assert.equal(merged.channels.length, 6);
  assert.equal(merged.channelsStale, true);
  assert.deepEqual(rankAvailableChannels([merged], "gpt-5.5"), []);
});

test("snapshot retry detection includes channel-only failures and needs-visit states", () => {
  assert.equal(snapshotNeedsRetry({ status: "needs_visit" }), true);
  assert.equal(snapshotNeedsRetry({ type: "sub2api", status: "ok", channelError: "monitor failed" }), false);
  assert.equal(snapshotNeedsRetry({ type: "sub2api", status: "ok", channelError: "monitor failed" }, { channelsOnly: true }), true);
  assert.equal(snapshotNeedsRetry({ type: "ezaiclub", status: "ok", channelsStale: true }, { channelsOnly: true }), true);
  assert.equal(snapshotNeedsRetry({ type: "sub2api", status: "ok", channelsStale: false }, { channelsOnly: true }), false);
  assert.equal(snapshotNeedsRetry({ type: "deepseek", status: "error" }, { channelsOnly: true }), false);
});
