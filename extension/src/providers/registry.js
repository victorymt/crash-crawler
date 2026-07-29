function validateAdapter(type, adapter) {
  if (!type || typeof type !== "string") throw new Error("Provider adapter type is required");
  if (!adapter || typeof adapter.collect !== "function") {
    throw new Error(`Provider adapter ${type} must define collect(config, context)`);
  }
}

export function createProviderRegistry(entries = []) {
  const adapters = new Map();
  const registry = {
    register(type, adapter) {
      validateAdapter(type, adapter);
      if (adapters.has(type)) throw new Error(`Provider adapter already registered: ${type}`);
      adapters.set(type, Object.freeze({ ...adapter, type }));
      return registry;
    },
    get(type) {
      return adapters.get(type) || null;
    },
    types() {
      return [...adapters.keys()];
    }
  };
  for (const [type, adapter] of entries) registry.register(type, adapter);
  return registry;
}
