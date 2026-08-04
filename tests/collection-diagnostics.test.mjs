import assert from "node:assert/strict";
import test from "node:test";

test("collection diagnostics redact secrets and classify common failures", async () => {
  const {
    COLLECTION_ERROR_CODES,
    classifyCollectionError,
    createCollectionContext,
    sanitizeDiagnosticMessage
  } = await import(`../extension/src/providers/runtime.js?diagnostics=${Date.now()}`);

  const message = sanitizeDiagnosticMessage(
    "Authorization: Bearer eyJabc.def.ghi api_key=sk-secret123456 refresh_token=refresh-value"
  );
  assert.equal(message.includes("eyJabc.def.ghi"), false);
  assert.equal(message.includes("sk-secret123456"), false);
  assert.equal(message.includes("refresh-value"), false);
  assert.equal(classifyCollectionError(new Error("Timed out after 10ms")), COLLECTION_ERROR_CODES.TIMEOUT);
  assert.equal(classifyCollectionError(new Error("Open extension settings and grant access")), COLLECTION_ERROR_CODES.PERMISSION_REQUIRED);
  assert.equal(classifyCollectionError(new Error("Frame with ID 0 was removed.")), COLLECTION_ERROR_CODES.TAB_CLOSED);

  const context = createCollectionContext({ trigger: "test" });
  await assert.rejects(
    () => context.runAttempt("secret-api", "network", async () => {
      throw new Error("Authorization=Bearer secret-token Cookie=session-secret");
    }),
    /secret-token/
  );
  assert.equal(context.attempts[0].message.includes("secret-token"), false);
  assert.equal(context.attempts[0].message.includes("session-secret"), false);
});
