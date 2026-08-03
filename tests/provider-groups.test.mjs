import assert from "node:assert/strict";
import test from "node:test";

import {
  groupProviderConfigs,
  moveProvider,
  moveProviderGroup,
  providerGroupLabel
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
