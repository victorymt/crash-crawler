import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_AUTH_SESSION_SOURCES,
  PROVIDER_AUTH_STATUSES,
  bindProviderAuthIdentity,
  mergeProviderAuthSession,
  normalizeProviderAuthSession,
  providerAuthIsExpired,
  providerAuthIdentityFromValue,
  providerAuthNeedsRefresh,
  providerAuthStatus,
  publicProviderAuthState,
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
    schemaVersion: 1,
    providerId: "",
    origin: "",
    userId: "",
    username: "",
    authToken: "access",
    refreshToken: "refresh",
    expiresAt: String(now + 30_000),
    source: "",
    generation: 0,
    updatedAt: "",
    verifiedAt: ""
  });
  assert.equal(providerAuthNeedsRefresh(session, now), true);
  assert.equal(providerAuthIsExpired(session, now), false);
  assert.equal(providerAuthIsExpired(session, now + 30_001), true);
  assert.equal(providerAuthStatus(session, now), PROVIDER_AUTH_STATUSES.EXPIRING);
  assert.equal(providerAuthStatus(session, now + 30_001), PROVIDER_AUTH_STATUSES.EXPIRED);
});

test("provider auth sessions bind identity and reject a different account", () => {
  const session = mergeProviderAuthSession(null, {
    providerId: "relay",
    origin: "https://relay.example/dashboard",
    authToken: "access",
    refreshToken: "refresh",
    source: PROVIDER_AUTH_SESSION_SOURCES.BROWSER_TAB,
    updatedAt: "2026-08-05T10:00:00Z"
  });
  const identity = providerAuthIdentityFromValue(JSON.stringify({
    data: { id: 42, display_name: "Alice" }
  }));
  assert.deepEqual(identity, { userId: "42", username: "Alice" });

  const bound = bindProviderAuthIdentity(session, { data: { id: 42, username: "alice" } }, {
    verifiedAt: "2026-08-05T10:01:00Z"
  });
  assert.equal(bound.userId, "42");
  assert.equal(bound.username, "alice");
  assert.equal(bound.generation, session.generation + 1);
  assert.equal(providerAuthStatus(bound, 0), PROVIDER_AUTH_STATUSES.AUTHENTICATED);

  assert.throws(
    () => bindProviderAuthIdentity(bound, { data: { id: 84, username: "bob" } }),
    (error) => error?.code === "account_mismatch"
  );
});

test("provider auth session merge ignores stale writes and versions rotations", () => {
  const first = mergeProviderAuthSession(null, {
    providerId: "relay",
    origin: "https://relay.example",
    userId: "42",
    authToken: "access-1",
    updatedAt: "2026-08-05T10:00:00Z"
  });
  const rotated = mergeProviderAuthSession(first, {
    ...first,
    authToken: "access-2",
    updatedAt: "2026-08-05T10:02:00Z"
  });
  assert.equal(rotated.generation, first.generation + 1);

  const stale = mergeProviderAuthSession(rotated, {
    ...rotated,
    authToken: "stale-access",
    generation: 99,
    updatedAt: "2026-08-05T10:01:00Z"
  });
  assert.deepEqual(stale, rotated);
  assert.throws(
    () => mergeProviderAuthSession(null, {
      providerId: "other",
      origin: "https://relay.example",
      authToken: "wrong-provider"
    }, { providerId: "relay", origin: "https://relay.example" }),
    (error) => error?.code === "provider_mismatch"
  );

  const publicState = publicProviderAuthState(rotated, 0);
  assert.equal(publicState.status, PROVIDER_AUTH_STATUSES.AUTHENTICATED);
  assert.equal(publicState.identityBound, true);
  assert.equal("authToken" in publicState, false);
  assert.equal("refreshToken" in publicState, false);
  assert.equal("username" in publicState, false);
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
