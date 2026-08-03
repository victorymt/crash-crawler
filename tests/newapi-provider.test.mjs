import assert from "node:assert/strict";
import test from "node:test";

function newApiSelfResponse(url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => "application/json" },
    async json() {
      return {
        success: true,
        message: "",
        data: {
          username: "alice",
          quota: 2500000,
          used_quota: 500000,
          request_count: 12
        }
      };
    }
  };
}

function jsonResponse(url, payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => "application/json" },
    async json() { return payload; }
  };
}

test("newapi provider collects quota from /api/user/self", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return newApiSelfResponse(url);
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?newapi=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "newapi",
    name: "New API",
    type: "newapi",
    targetUrl: "https://api.example.test/dashboard",
    enabled: true,
    secondaryUrls: []
  });

  assert.deepEqual(requestedUrls, ["https://api.example.test/api/user/self"]);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.balances[0].label, "剩余额度");
  assert.equal(snapshot.balances[0].value, "5.00");
  assert.equal(snapshot.usage[0].value, "$1.00 / $6.00");
  assert.equal(snapshot.usage[0].percent, 17);
  assert.equal(snapshot.metrics.some((item) => item.label === "账号" && item.value === "alice"), true);
  assert.equal(snapshot.raw.quota, 2500000);

  globalThis.fetch = originalFetch;
});

test("empty page provider auto-detects New API sites", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return newApiSelfResponse(url);
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?newapi-auto=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "newapi-auto",
    name: "New API Auto",
    type: "page",
    targetUrl: "https://relay.example.test/dashboard",
    enabled: true,
    secondaryUrls: [],
    parserRules: { balances: [], quotas: [], textMetrics: [] }
  });

  assert.deepEqual(requestedUrls, ["https://relay.example.test/api/user/self"]);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.balances[0].value, "5.00");

  globalThis.fetch = originalFetch;
});

test("newapi auto-detection refreshes modern access-token sessions", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  let refreshed = false;
  let retryHeaders = null;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    requestedPaths.push(parsed.pathname);
    if (parsed.pathname === "/api/status") {
      return jsonResponse(url, {
        success: true,
        data: { system_name: "New API", version: "sha-test" }
      });
    }
    if (parsed.pathname === "/api/user/auth/refresh") {
      assert.equal(options.method, "POST");
      refreshed = true;
      return jsonResponse(url, {
        success: true,
        data: { access_token: "temporary-token", user: { id: 42 } }
      });
    }
    if (parsed.pathname === "/api/user/self" && !refreshed) {
      return jsonResponse(url, { success: false, message: "unauthorized" }, 401);
    }
    if (parsed.pathname === "/api/user/self") {
      retryHeaders = options.headers;
      return newApiSelfResponse(url);
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const { detectProvider } = await import(`../extension/src/providers/index.js?newapi-refresh=${Date.now()}`);
    const detected = await detectProvider({
      id: "modern-newapi",
      name: "Modern New API",
      type: "page",
      targetUrl: "https://relay.example.test/dashboard/overview",
      enabled: true,
      secondaryUrls: [],
      parserRules: { balances: [], quotas: [], textMetrics: [] }
    });

    assert.equal(detected.type, "newapi");
    assert.equal(detected.snapshot.balances[0].value, "5.00");
    assert.deepEqual(requestedPaths, [
      "/api/user/self",
      "/api/status",
      "/api/user/auth/refresh",
      "/api/user/self"
    ]);
    assert.equal(retryHeaders.Authorization, "Bearer temporary-token");
    assert.equal(retryHeaders["New-Api-User"], "42");
    assert.equal(JSON.stringify(detected).includes("temporary-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("newapi page fallback does not treat dashboard API-key text as login", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let currentUrl = "";

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/user/self")) {
      return {
        ok: false,
        status: 404,
        url,
        headers: { get: () => "text/html" },
        async json() {
          throw new Error("not json");
        }
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => "text/html" },
      async text() {
        return "<html><title>AIHUB New API Dashboard</title><body>API Key\n令牌\n剩余额度 $5.00\n已用额度 $1.00 / 总额度 $6.00\n请求次数 12</body></html>";
      }
    };
  };
  globalThis.chrome = {
    tabs: {
      async query() {
        return [];
      },
      async create({ url }) {
        currentUrl = url;
        return { id: 1, status: "complete" };
      },
      async update(_tabId, { url }) {
        currentUrl = url;
        return { id: 1, status: "complete" };
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
      async executeScript() {
        return [{
          result: {
            title: "AIHUB New API Dashboard",
            url: currentUrl,
            text: "API Key\n令牌\n剩余额度 $5.00\n已用额度 $1.00 / 总额度 $6.00\n请求次数 12",
            jsonScripts: [],
            storageValues: []
          }
        }];
      }
    }
  };

  const { collectProvider } = await import(`../extension/src/providers/index.js?newapi-page=${Date.now()}`);
  const snapshot = await collectProvider({
    id: "aihub",
    name: "AIHUB",
    type: "newapi",
    targetUrl: "https://aihub.example.test/dashboard",
    enabled: true,
    secondaryUrls: [],
    parserRules: {
      loginHints: ["/login", "/user/login", "Sign in to", "Sign up", "用户登录", "登录账号", "登录 / 注册"],
      readyPattern: "额度|quota|API Key",
      balances: [{
        id: "newapi-balance",
        label: "剩余额度",
        pattern: "剩余额度\\s*[$](\\d+(?:\\.\\d+)?)",
        valueGroup: 1,
        currency: "USD",
        limit: 1
      }],
      quotas: [{
        id: "newapi-quota-usage",
        label: "额度用量",
        pattern: "已用额度\\s*[$](\\d+(?:\\.\\d+)?)\\s*/\\s*总额度\\s*[$](\\d+(?:\\.\\d+)?)",
        usedGroup: 1,
        limitGroup: 2,
        currency: "USD",
        limit: 1
      }],
      textMetrics: []
    }
  });

  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.balances[0].value, "5.00");
  assert.equal(snapshot.usage[0].value, "$1.00 / $6.00");

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});
