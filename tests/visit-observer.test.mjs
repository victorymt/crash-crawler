import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("visit observer registers only enabled opted-in origins", async () => {
  const originalChrome = globalThis.chrome;
  let registration = null;
  let unregistered = null;
  globalThis.chrome = {
    permissions: {
      async contains({ origins }) { return origins[0] !== "https://denied.test/*"; }
    },
    scripting: {
      async unregisterContentScripts(options) { unregistered = options; },
      async registerContentScripts(entries) { registration = entries[0]; }
    }
  };

  try {
    const {
      configsForObservedUrl,
      syncVisitObserver,
      VISIT_CONTENT_SCRIPT_ID
    } = await import(`../extension/src/background/visit_observer.js?observer=${Date.now()}`);
    const configs = [
      { id: "yes", enabled: true, refreshOnVisit: true, targetUrl: "https://yes.test/dashboard", secondaryUrls: [] },
      { id: "no", enabled: true, refreshOnVisit: false, targetUrl: "https://no.test/dashboard", secondaryUrls: [] },
      { id: "disabled", enabled: false, refreshOnVisit: true, targetUrl: "https://disabled.test", secondaryUrls: [] },
      { id: "denied", enabled: true, refreshOnVisit: true, targetUrl: "https://denied.test", secondaryUrls: [] }
    ];

    const result = await syncVisitObserver(configs);
    assert.deepEqual(unregistered, { ids: [VISIT_CONTENT_SCRIPT_ID] });
    assert.equal(result.registered, true);
    assert.deepEqual(registration.matches, ["https://yes.test/*"]);
    assert.deepEqual(configsForObservedUrl(configs, "https://yes.test/account").map((item) => item.id), ["yes"]);
    assert.deepEqual(configsForObservedUrl(configs, "https://no.test/dashboard"), []);

    const content = await readFile(new URL("../extension/src/content/provider_observer.js", import.meta.url), "utf8");
    assert.match(content, /provider:pageObserved/);
    assert.doesNotMatch(content, /localStorage|sessionStorage|executeScript/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
