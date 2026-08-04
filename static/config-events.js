(function configureProviderEvents() {
  const channel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("provider-usage-config-v1")
    : null;
  const listeners = new Set();

  if (channel) {
    channel.addEventListener("message", (event) => {
      if (event.data?.type !== "config-changed") return;
      for (const listener of listeners) listener(event.data);
    });
  }

  window.providerConfigEvents = Object.freeze({
    notify() {
      channel?.postMessage({ type: "config-changed", at: Date.now() });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}());
