import assert from "node:assert/strict";
import test from "node:test";

function jsonResponse(url, payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "application/json" },
    async json() {
      return payload;
    }
  };
}

function textResponse(url, text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "text/plain" },
    async json() {
      throw new Error("not json");
    },
    async text() {
      return text;
    }
  };
}

function installSub2ApiChromeStub(token = "test-token") {
  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 1, url: "https://aihub.example.test/dashboard", status: "complete" }];
      },
      async create({ url }) {
        return { id: 1, url, status: "complete" };
      },
      async get(tabId) {
        return { id: tabId, status: "complete" };
      },
      async remove() {},
      onUpdated: {
        addListener() {},
        removeListener() {}
      }
    },
    scripting: {
      async executeScript({ args }) {
        if (args?.[0] === "auth_token") return [{ result: token }];
        return [{ result: null }];
      }
    }
  };
}

test("sub2api provider collects dashboard data with localStorage bearer token", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  installSub2ApiChromeStub();
  const requested = [];
  globalThis.fetch = async (url, options = {}) => {
    requested.push({ url: String(url), auth: options.headers?.Authorization || "" });
    if (String(url).includes("/api/v1/auth/me")) {
      return jsonResponse(url, {
        code: "SUCCESS",
        data: { username: "cv_l", balance: 7.7 }
      });
    }
    if (String(url).includes("/api/v1/usage/dashboard/stats")) {
      return jsonResponse(url, {
        code: "SUCCESS",
        data: {
          today_requests: 199,
          total_requests: 249,
          today_actual_cost: 1.7509,
          today_standard_cost: 19.4541,
          total_actual_cost: 2.0021,
          total_standard_cost: 22.2454,
          today_tokens: "24.3M",
          total_tokens: "27.1M"
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const { collectProvider } = await import(`../extension/src/providers/index.js?sub2api=${Date.now()}`);
    const snapshot = await collectProvider({
      id: "aihub",
      name: "AIHub",
      type: "sub2api",
      targetUrl: "https://aihub.example.test/dashboard",
      enabled: true,
      secondaryUrls: []
    });

    assert.deepEqual(requested.map((item) => item.url), [
      "https://aihub.example.test/api/v1/auth/me?timezone=Asia%2FShanghai",
      "https://aihub.example.test/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai"
    ]);
    assert.equal(requested.every((item) => item.auth === "Bearer test-token"), true);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.balances[0].label, "余额");
    assert.equal(snapshot.balances[0].value, "7.70");
    assert.equal(snapshot.metrics.some((item) => item.label === "账号" && item.value === "cv_l"), true);
    assert.equal(snapshot.metrics.some((item) => item.label === "今日请求" && item.value === "199"), true);
    assert.equal(snapshot.usage.some((item) => item.label === "累计消费"), true);
    assert.equal(snapshot.raw.source, "sub2api");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("empty page provider auto-detects Sub2API after New API probe misses", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  installSub2ApiChromeStub();
  const requestedUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    requestedUrls.push(String(url));
    if (String(url).includes("/api/user/self")) return textResponse(url, "404 page not found", 404);
    assert.equal(options.headers?.Authorization, "Bearer test-token");
    if (String(url).includes("/api/v1/auth/me")) {
      return jsonResponse(url, { data: { username: "alice", balance: 12.3 } });
    }
    if (String(url).includes("/api/v1/usage/dashboard/stats")) {
      return jsonResponse(url, { data: { total_requests: 3 } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const { collectProvider } = await import(`../extension/src/providers/index.js?sub2api-auto=${Date.now()}`);
    const snapshot = await collectProvider({
      id: "aihub-auto",
      name: "AIHub Auto",
      type: "page",
      targetUrl: "https://aihub.example.test/dashboard",
      enabled: true,
      secondaryUrls: [],
      parserRules: { balances: [], quotas: [], textMetrics: [] }
    });

    assert.deepEqual(requestedUrls, [
      "https://aihub.example.test/api/user/self",
      "https://aihub.example.test/api/v1/auth/me?timezone=Asia%2FShanghai",
      "https://aihub.example.test/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai"
    ]);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.balances[0].value, "12.30");
    assert.equal(snapshot.raw.source, "sub2api");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("sub2api page parser understands AIHub dashboard text", async () => {
  const { parseSub2ApiDashboardTokens } = await import(`../extension/src/shared/parsers.js?sub2api-page=${Date.now()}`);
  const parsed = parseSub2ApiDashboardTokens([
    "余额",
    "$7.70",
    "可用",
    "今日请求",
    "199",
    "总计: 249",
    "今日消费",
    "$1.7509 / $19.4541",
    "总计: $2.0021 / $22.2454",
    "今日 Token",
    "24.3M",
    "累计 Token",
    "27.1M"
  ]);

  assert.equal(parsed.balances[0].value, "7.70");
  assert.equal(parsed.textMetrics.some((item) => item.label === "总请求" && item.value === "249"), true);
  assert.equal(parsed.usage.some((item) => item.label === "今日消费"), true);
  assert.equal(parsed.textMetrics.some((item) => item.label === "累计 Token" && item.value === "27.1M"), true);
});
