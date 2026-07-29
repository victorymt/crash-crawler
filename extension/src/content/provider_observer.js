(() => {
  const MIN_REPORT_INTERVAL_MS = 15_000;
  const MUTATION_DEBOUNCE_MS = 1_000;
  let lastReportedAt = 0;
  let timer = null;

  function report() {
    timer = null;
    const now = Date.now();
    if (now - lastReportedAt < MIN_REPORT_INTERVAL_MS) return;
    lastReportedAt = now;
    try {
      const pending = chrome.runtime.sendMessage({
        type: "provider:pageObserved",
        url: location.href
      });
      pending?.catch?.(() => undefined);
    } catch {
      // The extension may be reloading or shutting down.
    }
  }

  function schedule() {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(report, MUTATION_DEBOUNCE_MS);
  }

  schedule();
  addEventListener("pageshow", schedule);
  addEventListener("popstate", schedule);
  addEventListener("hashchange", schedule);
  if (document.documentElement && globalThis.MutationObserver) {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
