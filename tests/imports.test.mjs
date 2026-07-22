import assert from "node:assert/strict";
import test from "node:test";

test("extension modules import without syntax errors", async () => {
  await import("../extension/src/shared/config.js");
  await import("../extension/src/shared/snapshots.js");
  await import("../extension/src/shared/parsers.js");
});

test("normalizeProviderConfig preserves parser rules", async () => {
  const { normalizeProviderConfig } = await import("../extension/src/shared/config.js");
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
});

test("page provider template generates a unique id", async () => {
  const { pageProviderTemplate } = await import("../extension/src/options/options.js");
  const template = pageProviderTemplate([
    { id: "page-provider-1" },
    { id: "page-provider-2" }
  ]);
  assert.equal(template.id, "page-provider-3");
  assert.equal(template.type, "page");
  assert.equal(template.parserRules.quotas[0].label, "每周用量");
});
