import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviderAuthSession,
  providerAuthIsExpired,
  providerAuthNeedsRefresh,
  withProviderAuthMutation
} from "../extension/src/providers/auth_session.js";

test("provider auth sessions normalize tokens and classify expiry", () => {
  const now = 1_000_000;
  const session = normalizeProviderAuthSession({
    authToken: " access ",
    refreshToken: " refresh ",
    expiresAt: String(now + 30_000)
  });

  assert.deepEqual(session, {
    authToken: "access",
    refreshToken: "refresh",
    expiresAt: String(now + 30_000)
  });
  assert.equal(providerAuthNeedsRefresh(session, now), true);
  assert.equal(providerAuthIsExpired(session, now), false);
  assert.equal(providerAuthIsExpired(session, now + 30_001), true);
});

test("provider auth mutation lock serializes one provider without poisoning retries", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withProviderAuthMutation("provider-1", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    throw new Error("expected failure");
  });
  const second = withProviderAuthMutation("provider-1", async () => {
    events.push("second");
    return "ok";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "ok");
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});
