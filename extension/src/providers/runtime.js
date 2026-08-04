export const COLLECTION_ERROR_CODES = Object.freeze({
  NOT_LOGGED_IN: "NOT_LOGGED_IN",
  PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
  TIMEOUT: "TIMEOUT",
  API_REJECTED: "API_REJECTED",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  NEEDS_VISIT: "NEEDS_VISIT",
  TAB_CLOSED: "TAB_CLOSED",
  UNKNOWN: "UNKNOWN"
});

export const TAB_POLICIES = Object.freeze({
  REUSE_OPEN_TABS: "reuse-open-tabs",
  ALLOW_HIDDEN_TABS: "allow-hidden-tabs",
  API_ONLY: "api-only"
});

export const TAB_POLICY_VALUES = Object.freeze(Object.values(TAB_POLICIES));

const KNOWN_ERROR_CODES = new Set(Object.values(COLLECTION_ERROR_CODES));
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 300;

export class CollectionError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "CollectionError";
    this.code = KNOWN_ERROR_CODES.has(code) ? code : COLLECTION_ERROR_CODES.UNKNOWN;
    if (cause) this.cause = cause;
  }
}

export class NeedsVisitError extends CollectionError {
  constructor(message = "Open the provider page before refreshing") {
    super(COLLECTION_ERROR_CODES.NEEDS_VISIT, message);
    this.name = "NeedsVisitError";
  }
}

export function classifyCollectionError(error) {
  if (KNOWN_ERROR_CODES.has(error?.code)) return error.code;
  const constructorName = error?.constructor?.name || "";
  const message = String(error?.message || error || "");
  if (constructorName === "NotLoggedInError" || /not logged in|sign in|登录/i.test(message)) {
    return COLLECTION_ERROR_CODES.NOT_LOGGED_IN;
  }
  if (/grant access|permission|权限/i.test(message)) return COLLECTION_ERROR_CODES.PERMISSION_REQUIRED;
  if (/timed out|timeout|aborterror/i.test(message)) return COLLECTION_ERROR_CODES.TIMEOUT;
  if (/tab was closed|browser tab was closed|frame with id .* was removed|frame was detached|execution context was destroyed/i.test(message)) {
    return COLLECTION_ERROR_CODES.TAB_CLOSED;
  }
  if (constructorName === "ParserNeedsFixtureError" || /no .*fields? were recognized|rules matched|schema|shape/i.test(message)) {
    return COLLECTION_ERROR_CODES.SCHEMA_MISMATCH;
  }
  if (/http\s+(?:4|5)\d\d|rejected the request|api returned/i.test(message)) {
    return COLLECTION_ERROR_CODES.API_REJECTED;
  }
  return COLLECTION_ERROR_CODES.UNKNOWN;
}

export function sanitizeDiagnosticMessage(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[REDACTED]")
    .replace(/((?:authorization|cookie|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

export function createCollectionContext(input = {}) {
  if (input?.isCollectionContext) return input;
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const context = {
    ...input,
    isCollectionContext: true,
    trigger: String(input.trigger || "manual"),
    tabPolicy: TAB_POLICY_VALUES.includes(input.tabPolicy)
      ? input.tabPolicy
      : TAB_POLICIES.ALLOW_HIDDEN_TABS,
    attempts,
    async runAttempt(strategy, resource, work) {
      const startedAt = Date.now();
      try {
        await context.onAttemptStart?.({ strategy, resource, startedAt: new Date(startedAt).toISOString() });
      } catch {
        // Progress persistence must never make collection fail.
      }
      try {
        const value = context.runWithResource
          ? await context.runWithResource(resource, work)
          : await work();
        const attempt = {
          strategy,
          resource,
          status: value == null ? "empty" : "ok",
          ...(value == null ? { errorCode: COLLECTION_ERROR_CODES.SCHEMA_MISMATCH } : {}),
          durationMs: elapsedMs(startedAt)
        };
        attempts.push(attempt);
        try {
          await context.onAttempt?.({ ...attempt });
        } catch {
          // Progress persistence must never make collection fail.
        }
        return value;
      } catch (error) {
        const attempt = {
          strategy,
          resource,
          status: "failed",
          errorCode: classifyCollectionError(error),
          message: sanitizeDiagnosticMessage(error?.message || error),
          durationMs: elapsedMs(startedAt)
        };
        attempts.push(attempt);
        try {
          await context.onAttempt?.({ ...attempt });
        } catch {
          // Progress persistence must never hide the original collection error.
        }
        throw error;
      }
    }
  };
  return context;
}

export function collectionDiagnostics(context) {
  const attempts = (context?.attempts || []).map((attempt) => ({ ...attempt }));
  const fallbackUsed = attempts.some((attempt) => attempt.status === "failed" || attempt.status === "empty")
    && attempts.some((attempt) => attempt.status === "ok");
  return {
    trigger: String(context?.trigger || "manual"),
    tabPolicy: TAB_POLICY_VALUES.includes(context?.tabPolicy)
      ? context.tabPolicy
      : TAB_POLICIES.ALLOW_HIDDEN_TABS,
    fallbackUsed,
    attempts
  };
}

export function attachCollectionDiagnostics(snapshot, context) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const raw = snapshot.raw && typeof snapshot.raw === "object" && !Array.isArray(snapshot.raw)
    ? snapshot.raw
    : {};
  return {
    ...snapshot,
    raw: {
      ...raw,
      collection: collectionDiagnostics(context)
    }
  };
}

export function decorateCollectionError(error, context) {
  const decorated = error instanceof Error ? error : new Error(String(error));
  decorated.code = classifyCollectionError(decorated);
  decorated.collection = collectionDiagnostics(context);
  return decorated;
}
