export const UNGROUPED_PROVIDER_LABEL = "未分组";

export function providerGroupName(provider) {
  return String(provider?.group || "").trim();
}

export function providerGroupLabel(groupName) {
  return String(groupName || "").trim() || UNGROUPED_PROVIDER_LABEL;
}

export function groupProviderConfigs(configs) {
  const groups = new Map();
  for (const provider of configs || []) {
    const name = providerGroupName(provider);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(provider);
  }
  return [...groups].map(([name, providers]) => ({
    name,
    label: providerGroupLabel(name),
    providers
  }));
}

export function flattenProviderGroups(groups) {
  return groups.flatMap((group) => group.providers);
}

export function moveProvider(configs, providerId, targetGroupName, targetProviderId = null, after = false) {
  const groups = groupProviderConfigs(configs).map((group) => ({ ...group, providers: [...group.providers] }));
  let provider = null;
  for (const group of groups) {
    const index = group.providers.findIndex((item) => item.id === providerId);
    if (index < 0) continue;
    [provider] = group.providers.splice(index, 1);
    break;
  }
  if (!provider) return [...configs];

  let targetGroup = groups.find((group) => group.name === String(targetGroupName || "").trim());
  if (!targetGroup) {
    targetGroup = {
      name: String(targetGroupName || "").trim(),
      label: providerGroupLabel(targetGroupName),
      providers: []
    };
    groups.push(targetGroup);
  }
  const targetIndex = targetProviderId
    ? targetGroup.providers.findIndex((item) => item.id === targetProviderId)
    : -1;
  const insertAt = targetIndex < 0
    ? targetGroup.providers.length
    : targetIndex + (after ? 1 : 0);
  targetGroup.providers.splice(insertAt, 0, { ...provider, group: targetGroup.name });
  return flattenProviderGroups(groups.filter((group) => group.providers.length));
}

export function moveProviderGroup(configs, groupName, targetGroupName, after = false) {
  const groups = groupProviderConfigs(configs);
  const sourceIndex = groups.findIndex((group) => group.name === groupName);
  const originalTargetIndex = groups.findIndex((group) => group.name === targetGroupName);
  if (sourceIndex < 0 || originalTargetIndex < 0 || sourceIndex === originalTargetIndex) return [...configs];
  const [source] = groups.splice(sourceIndex, 1);
  const targetIndex = groups.findIndex((group) => group.name === targetGroupName);
  groups.splice(targetIndex + (after ? 1 : 0), 0, source);
  return flattenProviderGroups(groups);
}
