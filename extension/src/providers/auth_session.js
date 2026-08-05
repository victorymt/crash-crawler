export const PROVIDER_AUTH_SESSION_SCHEMA_VERSION = 1;
export const AUTH_SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;

export const PROVIDER_AUTH_SESSION_SOURCES = Object.freeze({
  BROWSER_TAB: "browser_tab",
  BROWSEROS: "browseros",
  LOCAL_SYNC: "local_sync",
  REFRESH: "refresh",
  SECRET: "secret",
  LEGACY: "legacy"
});

export const PROVIDER_AUTH_STATUSES = Object.freeze({
  MISSING: "missing",
  AUTHENTICATED: "authenticated",
  IDENTITY_UNBOUND: "identity_unbound",
  EXPIRING: "expiring",
  EXPIRED: "expired",
  REFRESH_FAILED: "refresh_failed",
  LOGIN_REQUIRED: "login_required",
  ACCOUNT_MISMATCH: "account_mismatch",
  BROWSER_UNAVAILABLE: "browser_unavailable",
  PERMISSION_REQUIRED: "permission_required"
});

export const PROVIDER_AUTH_ERROR_CODES = Object.freeze({
  ACCOUNT_MISMATCH: "account_mismatch",
  ORIGIN_MISMATCH: "origin_mismatch",
  PROVIDER_MISMATCH: "provider_mismatch"
});

const MAX_AUTH_TOKEN_LENGTH = 8192;
const MAX_EXPIRES_AT_LENGTH = 128;
const MAX_IDENTITY_LENGTH = 256;
const MAX_SOURCE_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 100;
const authMutationChains = new Map();

export class ProviderAuthSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderAuthSessionError";
    this.code = code;
  }
}

function normalizedString(value, maxLength) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : String(value || "").trim().slice(0, maxLength);
}

function normalizedGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function normalizedOrigin(value) {
  const candidate = normalizedString(value, 2048);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

function normalizedTimestamp(value) {
  const candidate = normalizedString(value, 128);
  if (!candidate) return "";
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function firstIdentityValue(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of keys) {
    const candidate = normalizedString(value[key], MAX_IDENTITY_LENGTH);
    if (candidate) return candidate;
  }
  return "";
}

function identityContainer(value) {
  let current = value;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return null;
  for (const key of ["data", "user", "account", "account_info", "accountInfo"]) {
    const nested = current[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const identity = providerAuthIdentityFromValue(nested);
      if (identity.userId || identity.username) return nested;
    }
  }
  return current;
}

export function providerAuthIdentityFromValue(value) {
  const container = identityContainer(value);
  if (!container) return { userId: "", username: "" };
  return {
    userId: firstIdentityValue(container, ["id", "user_id", "userId", "uuid", "sub"]),
    username: firstIdentityValue(container, [
      "display_name", "displayName", "username", "name", "email"
    ])
  };
}

export function normalizeProviderAuthSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authToken = normalizedString(value.authToken, MAX_AUTH_TOKEN_LENGTH);
  const refreshToken = normalizedString(value.refreshToken, MAX_AUTH_TOKEN_LENGTH);
  const expiresAt = normalizedString(value.expiresAt, MAX_EXPIRES_AT_LENGTH);
  if (!authToken && !refreshToken) return null;
  const source = normalizedString(value.source, MAX_SOURCE_LENGTH);
  return {
    schemaVersion: PROVIDER_AUTH_SESSION_SCHEMA_VERSION,
    providerId: normalizedString(value.providerId, MAX_PROVIDER_ID_LENGTH),
    origin: normalizedOrigin(value.origin),
    userId: normalizedString(value.userId, MAX_IDENTITY_LENGTH),
    username: normalizedString(value.username, MAX_IDENTITY_LENGTH),
    authToken,
    refreshToken,
    expiresAt,
    source: Object.values(PROVIDER_AUTH_SESSION_SOURCES).includes(source) ? source : "",
    generation: normalizedGeneration(value.generation),
    updatedAt: normalizedTimestamp(value.updatedAt),
    verifiedAt: normalizedTimestamp(value.verifiedAt)
  };
}

export function parseProviderAuthSession(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeProviderAuthSession(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializeProviderAuthSession(value) {
  const session = normalizeProviderAuthSession(value);
  return session ? JSON.stringify(session) : "";
}

export function providerAuthExpiresAt(value) {
  const session = normalizeProviderAuthSession(value);
  if (!session?.expiresAt) return null;
  const expiresAt = Number(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
}

export function providerAuthNeedsRefresh(
  value,
  now = Date.now(),
  bufferMs = AUTH_SESSION_REFRESH_BUFFER_MS
) {
  const expiresAt = providerAuthExpiresAt(value);
  return expiresAt != null && expiresAt - now <= bufferMs;
}

export function providerAuthIsExpired(value, now = Date.now()) {
  const expiresAt = providerAuthExpiresAt(value);
  return expiresAt != null && expiresAt <= now;
}

export function providerAuthStatus(value, now = Date.now()) {
  const session = normalizeProviderAuthSession(value);
  if (!session) return PROVIDER_AUTH_STATUSES.MISSING;
  if (providerAuthIsExpired(session, now)) return PROVIDER_AUTH_STATUSES.EXPIRED;
  if (providerAuthNeedsRefresh(session, now)) return PROVIDER_AUTH_STATUSES.EXPIRING;
  if (!session.userId && !session.username) return PROVIDER_AUTH_STATUSES.IDENTITY_UNBOUND;
  return PROVIDER_AUTH_STATUSES.AUTHENTICATED;
}

export function publicProviderAuthState(value, now = Date.now()) {
  const session = normalizeProviderAuthSession(value);
  return {
    status: providerAuthStatus(session, now),
    source: session?.source || null,
    identityBound: Boolean(session?.userId || session?.username),
    generation: session?.generation || 0,
    expiresAt: providerAuthExpiresAt(session),
    verifiedAt: session?.verifiedAt || null
  };
}

export function providerAuthIdentityMatches(expected, candidate) {
  const left = normalizeProviderAuthSession(expected);
  const right = normalizeProviderAuthSession(candidate);
  if (!left || !right) return true;
  if (left.userId && right.userId) return left.userId === right.userId;
  if (left.username && right.username) {
    return left.username.toLocaleLowerCase() === right.username.toLocaleLowerCase();
  }
  return true;
}

export function providerAuthSessionIsStale(current, candidate) {
  const left = normalizeProviderAuthSession(current);
  const right = normalizeProviderAuthSession(candidate);
  if (!left || !right || !left.updatedAt || !right.updatedAt) return false;
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (rightTime !== leftTime) return rightTime < leftTime;
  return right.generation < left.generation;
}

export function mergeProviderAuthSession(previous, incoming, options = {}) {
  const current = normalizeProviderAuthSession(previous);
  const candidate = normalizeProviderAuthSession(incoming);
  if (!candidate) return current;
  const expectedProviderId = normalizedString(options.providerId, MAX_PROVIDER_ID_LENGTH);
  const expectedOrigin = normalizedOrigin(options.origin);
  if (expectedProviderId && candidate.providerId && candidate.providerId !== expectedProviderId) {
    throw new ProviderAuthSessionError(
      PROVIDER_AUTH_ERROR_CODES.PROVIDER_MISMATCH,
      "Authentication session belongs to a different Provider"
    );
  }
  if (expectedOrigin && candidate.origin && candidate.origin !== expectedOrigin) {
    throw new ProviderAuthSessionError(
      PROVIDER_AUTH_ERROR_CODES.ORIGIN_MISMATCH,
      "Authentication session belongs to a different origin"
    );
  }
  if (current?.providerId && candidate.providerId && current.providerId !== candidate.providerId) {
    throw new ProviderAuthSessionError(
      PROVIDER_AUTH_ERROR_CODES.PROVIDER_MISMATCH,
      "Authentication session belongs to a different Provider"
    );
  }
  if (current?.origin && candidate.origin && current.origin !== candidate.origin) {
    throw new ProviderAuthSessionError(
      PROVIDER_AUTH_ERROR_CODES.ORIGIN_MISMATCH,
      "Authentication session belongs to a different origin"
    );
  }
  if (providerAuthSessionIsStale(current, candidate)) return current;
  if (!providerAuthIdentityMatches(current, candidate)) {
    throw new ProviderAuthSessionError(
      PROVIDER_AUTH_ERROR_CODES.ACCOUNT_MISMATCH,
      "Authentication session belongs to a different account"
    );
  }

  const now = normalizedTimestamp(options.now) || new Date().toISOString();
  const verifiedAt = normalizedTimestamp(options.verifiedAt)
    || candidate.verifiedAt
    || current?.verifiedAt
    || "";
  const merged = {
    schemaVersion: PROVIDER_AUTH_SESSION_SCHEMA_VERSION,
    providerId: candidate.providerId || expectedProviderId
      || current?.providerId || "",
    origin: candidate.origin || expectedOrigin || current?.origin || "",
    userId: candidate.userId || current?.userId || "",
    username: candidate.username || current?.username || "",
    authToken: candidate.authToken || current?.authToken || "",
    refreshToken: candidate.refreshToken || current?.refreshToken || "",
    expiresAt: candidate.expiresAt || current?.expiresAt || "",
    source: candidate.source
      || normalizedString(options.source, MAX_SOURCE_LENGTH)
      || current?.source
      || "",
    generation: candidate.generation,
    updatedAt: candidate.updatedAt,
    verifiedAt
  };
  const materiallyChanged = !current
    || current.authToken !== merged.authToken
    || current.refreshToken !== merged.refreshToken
    || current.expiresAt !== merged.expiresAt
    || current.userId !== merged.userId
    || current.username !== merged.username
    || current.providerId !== merged.providerId
    || current.origin !== merged.origin;
  merged.generation = Math.max(
    candidate.generation,
    current?.generation || 0,
    materiallyChanged ? (current?.generation || 0) + 1 : 0
  );
  merged.updatedAt = materiallyChanged || !current?.updatedAt
    ? (candidate.updatedAt || now)
    : current.updatedAt;
  return normalizeProviderAuthSession(merged);
}

export function bindProviderAuthIdentity(session, identityValue, options = {}) {
  const identity = providerAuthIdentityFromValue(identityValue);
  const identityVerified = Boolean(identity.userId || identity.username);
  return mergeProviderAuthSession(session, {
    ...session,
    ...identity,
    verifiedAt: identityVerified
      ? (options.verifiedAt || new Date().toISOString())
      : session?.verifiedAt
  }, options);
}

export function providerAuthSessionChanged(previous, current) {
  const left = normalizeProviderAuthSession(previous);
  const right = normalizeProviderAuthSession(current);
  return left?.authToken !== right?.authToken
    || left?.refreshToken !== right?.refreshToken
    || left?.expiresAt !== right?.expiresAt;
}

export async function withProviderAuthMutation(providerId, work) {
  const key = String(providerId || "").trim();
  if (!key) return work();
  const previous = authMutationChains.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.then(() => undefined, () => undefined);
  authMutationChains.set(key, settled);
  try {
    return await run;
  } finally {
    if (authMutationChains.get(key) === settled) authMutationChains.delete(key);
  }
}
