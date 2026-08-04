(function initializeProviderApi() {
  let tokenPromise = null;

  async function responseJson(response) {
    try {
      return await response.json();
    } catch {
      throw new Error(`HTTP ${response.status}: invalid JSON response`);
    }
  }

  async function fetchLocalSyncToken(force = false) {
    if (force) tokenPromise = null;
    if (!tokenPromise) {
      tokenPromise = fetch("/api/local-sync/token", {
        cache: "no-store",
        headers: { Accept: "application/json" }
      }).then(async (response) => {
        const data = await responseJson(response);
        if (!response.ok || !data.token) throw new Error(data.error || "无法读取本地同步令牌");
        return data.token;
      }).catch((error) => {
        tokenPromise = null;
        throw error;
      });
    }
    return tokenPromise;
  }

  async function requestJson(url, options = {}) {
    const { timeout = 180000, ...requestOptions } = options;
    const method = String(requestOptions.method || "GET").toUpperCase();
    const mutating = !["GET", "HEAD"].includes(method);

    async function attempt(allowTokenRetry) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeout);
      try {
        const headers = new Headers(requestOptions.headers || {});
        headers.set("Accept", "application/json");
        if (requestOptions.body != null && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        if (mutating) {
          headers.set("X-Provider-Sync-Token", await fetchLocalSyncToken());
        }
        const response = await fetch(url, {
          ...requestOptions,
          method,
          headers,
          signal: controller.signal
        });
        const data = await responseJson(response);
        if (response.status === 401 && mutating && allowTokenRetry) {
          await fetchLocalSyncToken(true);
          return attempt(false);
        }
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (new URL(url, window.location.href).pathname === "/api/local-sync/token" && data.token) {
          tokenPromise = Promise.resolve(data.token);
        }
        return data;
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    return attempt(true);
  }

  window.providerApi = Object.freeze({ requestJson });
}());
