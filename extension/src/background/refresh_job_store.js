export const REFRESH_RUN_KEY = "providerRefreshRun";

let refreshRunMutationChain = Promise.resolve();

function sessionStorage() {
  return globalThis.chrome?.storage?.session || null;
}

export async function getRefreshRun() {
  const storage = sessionStorage();
  if (!storage?.get) return null;
  const data = await storage.get(REFRESH_RUN_KEY);
  const run = data?.[REFRESH_RUN_KEY];
  return run && typeof run === "object" ? run : null;
}

export async function saveRefreshRun(run) {
  const storage = sessionStorage();
  if (!storage?.set) return run;
  await storage.set({ [REFRESH_RUN_KEY]: run });
  return run;
}

export async function mutateRefreshRun(runId, work) {
  const run = refreshRunMutationChain.then(async () => {
    const current = await getRefreshRun();
    if (!current || current.runId !== runId) return current;
    const next = await work(current);
    if (!next || next.runId !== runId) return current;
    next.updatedAt = new Date().toISOString();
    await saveRefreshRun(next);
    return next;
  });
  refreshRunMutationChain = run.then(() => undefined, () => undefined);
  return run;
}
