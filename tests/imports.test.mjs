import test from "node:test";

test("extension modules import without syntax errors", async () => {
  await import("../extension/src/shared/config.js");
  await import("../extension/src/shared/snapshots.js");
  await import("../extension/src/shared/parsers.js");
});
