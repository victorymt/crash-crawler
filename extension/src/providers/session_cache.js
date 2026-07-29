const SESSION_HINTS_KEY = "providerSessionHints";
const MAX_SESSION_HINT_TTL_MS = 24 * 60 * 60 * 1000;

let sessionMutationChain = Promise.resolve();

function sessionStorage() {
  return globalThis.chrome?.storage?.session || null;
}

async function readHints() {
  const storage = sessionStorage();
  if (!storage?.get) return {};
  const data = await storage.get(SESSION_HINTS_KEY);
  const hints = data?.[SESSION_HINTS_KEY];
  return hints && typeof hints === "object" ? hints : {};
}

async function mutateHints(work) {
  const run = sessionMutationChain.then(async () => {
    const storage = sessionStorage();
    if (!storage?.set) return null;
    const hints = await readHints();
    const result = await work(hints);
    await storage.set({ [SESSION_HINTS_KEY]: hints });
    return result;
  });
  sessionMutationChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function getSessionHint(providerId, name) {
  const hints = await readHints();
  const hint = hints?.[providerId]?.[name];
  if (!hint || typeof hint !== "object") return "";
  if (!Number.isFinite(hint.expiresAt) || hint.expiresAt <= Date.now()) {
    await deleteSessionHint(providerId, name);
    return "";
  }
  return typeof hint.value === "string" ? hint.value : "";
}

export async function setSessionHint(providerId, name, value, ttlMs) {
  const normalizedValue = typeof value === "string" ? value : String(value || "");
  if (!normalizedValue) return deleteSessionHint(providerId, name);
  const ttl = Math.min(MAX_SESSION_HINT_TTL_MS, Math.max(1000, Number(ttlMs) || 1000));
  return mutateHints((hints) => {
    hints[providerId] ||= {};
    hints[providerId][name] = { value: normalizedValue, expiresAt: Date.now() + ttl };
    return normalizedValue;
  });
}

export async function deleteSessionHint(providerId, name) {
  return mutateHints((hints) => {
    if (!hints[providerId]) return false;
    delete hints[providerId][name];
    if (!Object.keys(hints[providerId]).length) delete hints[providerId];
    return true;
  });
}

export async function clearProviderSessionHints(providerId) {
  return mutateHints((hints) => {
    const existed = Boolean(hints[providerId]);
    delete hints[providerId];
    return existed;
  });
}
