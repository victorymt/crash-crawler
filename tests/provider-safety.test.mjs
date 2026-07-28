import assert from "node:assert/strict";
import test from "node:test";

test("page extraction does not read Web Storage and bounds returned selector values", async () => {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  const originalWindow = globalThis.window;
  let storageReads = 0;
  const nodes = Array.from({ length: 150 }, (_, index) => ({
    textContent: `value-${index}`,
    innerText: `value-${index}`,
    getAttribute() { return `value-${index}`; }
  }));

  globalThis.chrome = { scripting: { async executeScript({ func, args }) {
    globalThis.document = {
      title: "Usage",
      body: { innerText: "private page text" },
      querySelectorAll(selector) {
        if (selector === ".metric") return nodes;
        return [];
      }
    };
    globalThis.location = { href: "https://example.test/usage" };
    globalThis.window = {
      localStorage: { get length() { storageReads += 1; return 1; } },
      sessionStorage: { get length() { storageReads += 1; return 1; } }
    };
    return [{ result: await func(args[0]) }];
  } } };

  const { extractTokensFromTab } = await import(`../extension/src/providers/index.js?safety=${Date.now()}`);
  const result = await extractTokensFromTab(1, { waitMs: 100, minWaitMs: 0 }, [
    { id: "metric", selector: ".metric" }
  ]);

  assert.equal(storageReads, 0);
  assert.equal(Object.hasOwn(result, "storageValues"), false);
  assert.equal(result.selectorResults.metric.matchCount, 150);
  assert.equal(result.selectorResults.metric.values.length, 100);

  globalThis.chrome = originalChrome;
  globalThis.document = originalDocument;
  globalThis.location = originalLocation;
  globalThis.window = originalWindow;
});

test("network and tab waits reject when their deadline expires", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  globalThis.chrome = {
    tabs: {
      async get() { return { id: 1, status: "loading" }; },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} }
    }
  };

  const { requestWithTimeout, waitForTabComplete } = await import(`../extension/src/providers/index.js?timeouts=${Date.now()}`);
  await assert.rejects(
    () => requestWithTimeout("https://example.test", {}, async (response) => response, 10),
    /Timed out after 10ms/
  );
  await assert.rejects(() => waitForTabComplete(1, 10), /Timed out after 10ms/);

  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test("JSON token flattening is depth and count bounded", async () => {
  const { flattenJsonValues } = await import("../extension/src/shared/parsers.js");
  let deeplyNested = "leaf";
  for (let index = 0; index < 100; index += 1) deeplyNested = { child: deeplyNested };
  assert.doesNotThrow(() => flattenJsonValues(deeplyNested));

  const manyValues = Array.from({ length: 6000 }, (_, index) => index);
  assert.equal(flattenJsonValues(manyValues).length, 5000);
  assert.equal(flattenJsonValues("x".repeat(12000))[0].length, 10000);
});
