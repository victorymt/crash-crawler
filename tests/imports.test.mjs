import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("extension modules import without syntax errors", async () => {
  await import("../extension/src/shared/config.js");
  await import("../extension/src/shared/snapshots.js");
  await import("../extension/src/shared/parsers.js");
});

test("normalizeProviderConfig preserves parser rules", async () => {
  const { normalizeProviderConfig, originsForConfig } = await import("../extension/src/shared/config.js");
  const config = normalizeProviderConfig({
    id: "generic",
    name: "Generic",
    type: "page",
    targetUrl: "https://example.test",
    parserRules: {
      loginHints: ["Login"],
      balances: [{ label: "余额", pattern: "balance" }]
    }
  });
  assert.equal(config.type, "page");
  assert.equal(config.parserRules.loginHints[0], "Login");
  assert.equal(config.parserRules.balances[0].label, "余额");
  const snakeCaseConfig = normalizeProviderConfig({
    id: "snake",
    type: "page",
    target_url: "https://example.test/dashboard",
    secondary_urls: [{ label: "详情", url: "https://example.test/detail" }]
  });
  assert.equal(snakeCaseConfig.targetUrl, "https://example.test/dashboard");
  assert.equal(snakeCaseConfig.secondaryUrls[0].url, "https://example.test/detail");
  assert.equal(snakeCaseConfig.secondaryUrls[0].id, "page-1");
  assert.deepEqual(originsForConfig(snakeCaseConfig), ["https://example.test/*"]);
  assert.throws(() => normalizeProviderConfig({
    id: "invalid-selector-rule",
    type: "page",
    targetUrl: "https://example.test",
    parserRules: { balances: [{ label: "余额" }] }
  }), /requires a CSS selector/);
});

test("page provider template generates a unique id", async () => {
  const { metricRuleTemplate, pageProviderTemplate } = await import("../extension/src/options/options.js");
  const template = pageProviderTemplate([
    { id: "page-provider-1" },
    { id: "page-provider-2" }
  ]);
  assert.equal(template.id, "page-provider-3");
  assert.equal(template.type, "page");
  assert.equal(template.schemaVersion, 2);
  assert.deepEqual(template.parserRules.quotas, []);
  assert.equal(metricRuleTemplate("quotas").mode, "combined");
});

test("options page uses a structured provider editor", async () => {
  const html = await readFile(new URL("../extension/src/options/options.html", import.meta.url), "utf8");
  assert.match(html, /id="source-target-url"/);
  assert.match(html, /data-editor-action="add-balance"/);
  assert.match(html, /data-editor-action="add-quota"/);
  assert.doesNotMatch(html, /id="source-json"/);
});

test("manifest declares optional host permissions for user sources", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
});
