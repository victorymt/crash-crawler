import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteProviderGroup,
  groupProviderConfigs,
  moveProvider,
  moveProvidersToGroup,
  moveProviderGroup,
  providerGroupLabel,
  renameProviderGroup
} from "../extension/src/shared/provider_groups.js";

const providers = [
  { id: "a", name: "A", group: "低倍率" },
  { id: "b", name: "B", group: "" },
  { id: "c", name: "C", group: "低倍率" },
  { id: "d", name: "D", group: "备用" }
];

test("provider groups use first appearance order and collect matching providers", () => {
  const groups = groupProviderConfigs(providers);
  assert.deepEqual(groups.map((group) => group.label), ["低倍率", "未分组", "备用"]);
  assert.deepEqual(groups[0].providers.map((provider) => provider.id), ["a", "c"]);
  assert.equal(providerGroupLabel(""), "未分组");
});

test("providers can be reordered within and across groups", () => {
  const reordered = moveProvider(providers, "c", "低倍率", "a");
  assert.deepEqual(reordered.map((provider) => provider.id), ["c", "a", "b", "d"]);

  const regrouped = moveProvider(reordered, "b", "备用", "d");
  assert.deepEqual(regrouped.map((provider) => provider.id), ["c", "a", "b", "d"]);
  assert.equal(regrouped.find((provider) => provider.id === "b").group, "备用");
  assert.deepEqual(groupProviderConfigs(regrouped).map((group) => group.label), ["低倍率", "备用"]);
});

test("whole provider groups can be reordered", () => {
  const moved = moveProviderGroup(providers, "备用", "低倍率");
  assert.deepEqual(moved.map((provider) => provider.id), ["d", "a", "c", "b"]);
  assert.deepEqual(groupProviderConfigs(moved).map((group) => group.label), ["备用", "低倍率", "未分组"]);
});

test("multiple providers can be moved to an existing or new group", () => {
  const movedToExisting = moveProvidersToGroup(providers, ["a", "c"], "备用");
  assert.deepEqual(movedToExisting.map((provider) => provider.id), ["b", "d", "a", "c"]);
  assert.deepEqual(groupProviderConfigs(movedToExisting).map((group) => group.label), ["未分组", "备用"]);

  const movedToNew = moveProvidersToGroup(providers, ["a", "b"], "常用");
  assert.deepEqual(movedToNew.map((provider) => provider.id), ["c", "d", "a", "b"]);
  assert.deepEqual(groupProviderConfigs(movedToNew).map((group) => group.label), ["低倍率", "备用", "常用"]);
  assert.ok(movedToNew.filter((provider) => ["a", "b"].includes(provider.id)).every((provider) => provider.group === "常用"));
});

test("provider groups can be renamed and deleted without deleting providers", () => {
  const renamed = renameProviderGroup(providers, "低倍率", "常用");
  assert.deepEqual(renamed.map((provider) => provider.id), ["a", "b", "c", "d"]);
  assert.deepEqual(groupProviderConfigs(renamed).map((group) => group.label), ["常用", "未分组", "备用"]);

  const deleted = deleteProviderGroup(providers, "备用");
  assert.deepEqual(deleted.map((provider) => provider.id), ["a", "c", "b", "d"]);
  assert.deepEqual(groupProviderConfigs(deleted).map((group) => group.label), ["低倍率", "未分组"]);
  assert.equal(deleted.find((provider) => provider.id === "d").group, "");
});
