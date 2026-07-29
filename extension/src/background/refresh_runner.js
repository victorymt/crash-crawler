import { createCollectionContext, TAB_POLICY_VALUES } from "../providers/runtime.js";
import { getRefreshRun, mutateRefreshRun, saveRefreshRun } from "./refresh_job_store.js";

export const DEFAULT_NETWORK_CONCURRENCY = 8;
export const DEFAULT_PAGE_CONCURRENCY = 2;
const REFRESH_RUN_RESUME_WINDOW_MS = 10 * 60 * 1000;
const PROVIDER_LEASE_MS = 2 * 60 * 1000;

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  async run(work) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function runId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function providerState(config, previous = {}) {
  return previous[config.id] || {
    state: "pending",
    currentStep: null,
    lastAttempt: null,
    createdTabId: null,
    leaseUntil: null,
    completedAt: null,
    snapshotStatus: null
  };
}

export function resumeContextForRefreshRun(run) {
  if (!run || run.state !== "running") return null;
  if (typeof run.trigger !== "string" || !TAB_POLICY_VALUES.includes(run.tabPolicy)) return null;
  const updatedAt = Date.parse(run.updatedAt || run.startedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > REFRESH_RUN_RESUME_WINDOW_MS) return null;
  return { trigger: run.trigger, tabPolicy: run.tabPolicy };
}

function canResume(existing, configs, context) {
  const resumeContext = resumeContextForRefreshRun(existing);
  if (!resumeContext) return false;
  if (resumeContext.trigger !== context.trigger || resumeContext.tabPolicy !== context.tabPolicy) return false;
  const ids = new Set(configs.map((config) => config.id));
  return Object.keys(existing.providers || {}).some((id) => ids.has(id));
}

async function closeRecordedTabs(run) {
  for (const state of Object.values(run?.providers || {})) {
    if (state?.createdTabId == null || !globalThis.chrome?.tabs?.remove) continue;
    try {
      await chrome.tabs.remove(state.createdTabId);
    } catch {
      // The previous worker or the user may already have closed it.
    }
  }
}

export async function recoverRefreshRun(resume) {
  const existing = await getRefreshRun();
  if (!existing || existing.state !== "running") return null;
  const context = resumeContextForRefreshRun(existing);
  if (context) return resume(context);

  await closeRecordedTabs(existing);
  await mutateRefreshRun(existing.runId, (current) => ({
    ...current,
    state: "interrupted",
    completedAt: new Date().toISOString(),
    providers: Object.fromEntries(Object.entries(current.providers || {}).map(([id, state]) => [
      id,
      { ...state, createdTabId: null, leaseUntil: null }
    ]))
  }));
  return null;
}

async function prepareRun(configs, context) {
  const existing = await getRefreshRun();
  if (canResume(existing, configs, context)) {
    const providers = Object.fromEntries(configs.map((config) => {
      const previous = providerState(config, existing.providers || {});
      return [config.id, previous.state === "complete" ? previous : {
        ...previous,
        state: "pending",
        currentStep: null,
        leaseUntil: null
      }];
    }));
    const resumed = { ...existing, providers, resumedAt: new Date().toISOString() };
    await saveRefreshRun(resumed);
    return resumed;
  }

  await closeRecordedTabs(existing);

  const now = new Date().toISOString();
  const created = {
    runId: runId(),
    state: "running",
    trigger: context.trigger,
    tabPolicy: context.tabPolicy,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    providers: Object.fromEntries(configs.map((config) => [config.id, providerState(config)]))
  };
  await saveRefreshRun(created);
  return created;
}

async function cleanupOrphanTab(run, providerId) {
  const tabId = run.providers?.[providerId]?.createdTabId;
  if (tabId == null || !globalThis.chrome?.tabs?.remove) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // A user or a previous worker may already have closed it.
  }
  await mutateRefreshRun(run.runId, (current) => ({
    ...current,
    providers: {
      ...current.providers,
      [providerId]: { ...current.providers[providerId], createdTabId: null }
    }
  }));
}

export async function runRefreshBatch({
  configs,
  previousSnapshots,
  context: contextInput = {},
  collect,
  saveSnapshot,
  networkConcurrency = DEFAULT_NETWORK_CONCURRENCY,
  pageConcurrency = DEFAULT_PAGE_CONCURRENCY
}) {
  const baseContext = createCollectionContext(contextInput);
  const networkGate = new Semaphore(networkConcurrency);
  const pageGate = new Semaphore(pageConcurrency);
  const run = await prepareRun(configs, baseContext);
  const results = new Map();

  await Promise.all(configs.map(async (config) => {
    const recorded = run.providers?.[config.id];
    if (recorded?.state === "complete" && previousSnapshots[config.id]) {
      results.set(config.id, previousSnapshots[config.id]);
      return;
    }
    await cleanupOrphanTab(run, config.id);

    const updateProvider = (work) => mutateRefreshRun(run.runId, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        [config.id]: work(current.providers[config.id] || providerState(config))
      }
    }));
    const context = createCollectionContext({
      ...baseContext,
      isCollectionContext: false,
      attempts: [],
      runWithResource(resource, work) {
        if (resource === "network") return networkGate.run(work);
        if (resource === "page") return pageGate.run(work);
        return work();
      },
      onAttemptStart(attempt) {
        return updateProvider((state) => ({
          ...state,
          state: "running",
          currentStep: attempt.strategy,
          leaseUntil: new Date(Date.now() + PROVIDER_LEASE_MS).toISOString()
        }));
      },
      onAttempt(attempt) {
        return updateProvider((state) => ({ ...state, lastAttempt: attempt }));
      },
      onTabCreated(tabId) {
        return updateProvider((state) => ({ ...state, createdTabId: tabId }));
      },
      onTabClosed(tabId) {
        return updateProvider((state) => ({
          ...state,
          createdTabId: state.createdTabId === tabId ? null : state.createdTabId
        }));
      }
    });

    const snapshot = await collect(config, previousSnapshots[config.id], context);
    const saved = await saveSnapshot(snapshot);
    if (saved) results.set(config.id, saved);
    await updateProvider((state) => ({
      ...state,
      state: "complete",
      currentStep: null,
      createdTabId: null,
      leaseUntil: null,
      completedAt: new Date().toISOString(),
      snapshotStatus: saved?.status || snapshot?.status || null
    }));
  }));

  await mutateRefreshRun(run.runId, (current) => ({
    ...current,
    state: "complete",
    completedAt: new Date().toISOString()
  }));
  return configs.map((config) => results.get(config.id)).filter(Boolean);
}
