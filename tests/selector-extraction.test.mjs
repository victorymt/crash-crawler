import assert from "node:assert/strict";
import test from "node:test";

function node(value) {
  return {
    textContent: value,
    innerText: value,
    value,
    getAttribute() { return value; }
  };
}

test("selector extraction waits for complete rules and excludes page-wide data", async () => {
  const originalChrome = globalThis.chrome;
  let usedReads = 0;
  let limitReads = 0;
  const document = {
    title: "Usage",
    body: { innerText: "private full page text" },
    querySelectorAll(selector) {
      if (selector === ".used") { usedReads += 1; return [node("12")]; }
      if (selector === ".limit") { limitReads += 1; return limitReads < 2 ? [] : [node("20")]; }
      if (selector.includes("script")) return [node('{"secret":true}')];
      return [];
    }
  };
  globalThis.chrome = {
    scripting: {
      async executeScript({ func, args }) {
        const previousDocument = globalThis.document;
        const previousLocation = globalThis.location;
        const previousWindow = globalThis.window;
        globalThis.document = document;
        globalThis.location = { href: "https://example.test/usage" };
        globalThis.window = {
          localStorage: { length: 1, key() { return "secret"; }, getItem() { return "token"; } },
          sessionStorage: { length: 0 }
        };
        try { return [{ result: await func(args[0]) }]; }
        finally {
          globalThis.document = previousDocument;
          globalThis.location = previousLocation;
          globalThis.window = previousWindow;
        }
      }
    }
  };
  const { extractTokensFromTab } = await import(`../extension/src/providers/index.js?extract=${Date.now()}`);
  const result = await extractTokensFromTab(1, { waitMs: 100, minWaitMs: 0, stableSamples: 1 }, [{
    id: "quota", mode: "separate", usedSelector: ".used", limitSelector: ".limit"
  }]);
  assert.ok(usedReads >= 2);
  assert.ok(limitReads >= 2);
  assert.equal(result.text, "");
  assert.deepEqual(result.tokens, []);
  assert.deepEqual(result.jsonScripts, []);
  assert.deepEqual(result.storageValues, []);
  assert.deepEqual(result.selectorResults.quota.usedValues, ["12"]);
  assert.deepEqual(result.selectorResults.quota.limitValues, ["20"]);
  globalThis.chrome = originalChrome;
});

test("an explicit ready selector takes priority over rule readiness", async () => {
  const originalChrome = globalThis.chrome;
  let readyReads = 0;
  globalThis.chrome = { scripting: { async executeScript({ func, args }) {
    globalThis.document = {
      title: "Usage", body: { innerText: "" },
      querySelectorAll(selector) {
        if (selector === ".ready") { readyReads += 1; return [node("")]; }
        return [];
      }
    };
    globalThis.location = { href: "https://example.test" };
    globalThis.window = { localStorage: { length: 0 }, sessionStorage: { length: 0 } };
    return [{ result: await func(args[0]) }];
  } } };
  const { extractTokensFromTab } = await import(`../extension/src/providers/index.js?ready=${Date.now()}`);
  await extractTokensFromTab(1, { waitMs: 10, minWaitMs: 0, readySelector: ".ready" }, [{ id: "missing", selector: ".missing" }]);
  assert.equal(readyReads, 1);
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.window;
  globalThis.chrome = originalChrome;
});
