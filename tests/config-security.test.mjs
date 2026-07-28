import assert from "node:assert/strict";
import test from "node:test";

import { normalizeProviderConfig } from "../extension/src/shared/config.js";

function provider(parserRules = {}) {
  return {
    id: "security-test",
    name: "Security Test",
    type: "page",
    targetUrl: "https://example.test/dashboard",
    parserRules
  };
}

test("provider config drops unsupported parser controls", () => {
  const normalized = normalizeProviderConfig(provider({
    collectPageTokens: true,
    unknownControl: "ignored",
    waitOptions: { waitMs: 5000, pollMs: 200, collectPageTokens: true },
    balances: [{ id: "balance", label: "Balance", selector: ".balance" }]
  }));

  assert.equal(normalized.parserRules.collectPageTokens, undefined);
  assert.equal(normalized.parserRules.unknownControl, undefined);
  assert.deepEqual(normalized.parserRules.waitOptions, { waitMs: 5000, pollMs: 200 });
});

test("provider config rejects unsafe or incompatible regexes", () => {
  assert.throws(() => normalizeProviderConfig(provider({
    balances: [{ id: "balance", label: "Balance", pattern: "(a+)+$" }]
  })), /unsafe repetition/);

  assert.throws(() => normalizeProviderConfig(provider({
    balances: [{ id: "balance", label: "Balance", pattern: "(\\d+)", flags: "g" }]
  })), /flags are unsupported/);
});

test("provider config enforces bounded waits, pages, and URL credentials", () => {
  assert.throws(() => normalizeProviderConfig(provider({
    waitOptions: { waitMs: 60000 },
    balances: [{ id: "balance", label: "Balance", selector: ".balance" }]
  })), /waitOptions\.waitMs/);

  assert.throws(() => normalizeProviderConfig({
    ...provider(),
    targetUrl: "https://user:password@example.test/dashboard"
  }), /must not contain credentials/);

  assert.throws(() => normalizeProviderConfig({
    ...provider(),
    secondaryUrls: Array.from({ length: 9 }, (_, index) => ({
      id: `page-${index}`,
      label: `Page ${index}`,
      url: `https://example.test/${index}`
    }))
  }), /too many secondary pages/);
});
