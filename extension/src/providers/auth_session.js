export const AUTH_SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;

const MAX_AUTH_TOKEN_LENGTH = 8192;
const MAX_EXPIRES_AT_LENGTH = 128;
const authMutationChains = new Map();

function normalizedString(value, maxLength) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : String(value || "").trim().slice(0, maxLength);
}

export function normalizeProviderAuthSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authToken = normalizedString(value.authToken, MAX_AUTH_TOKEN_LENGTH);
  const refreshToken = normalizedString(value.refreshToken, MAX_AUTH_TOKEN_LENGTH);
  const expiresAt = normalizedString(value.expiresAt, MAX_EXPIRES_AT_LENGTH);
  if (!authToken && !refreshToken) return null;
  return {
    authToken,
    refreshToken,
    expiresAt
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
