import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeProviderConfig,
  providersFromImportDocument
} from "../extension/src/shared/config.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/provider-config-contract.json", import.meta.url),
  "utf8"
));
const schema = JSON.parse(await readFile(
  new URL("../schemas/provider-config-v4.schema.json", import.meta.url),
  "utf8"
));

test("portable provider contract limits match extension runtime", () => {
  assert.equal(schema.$defs.identifier.maxLength, 100);
  assert.equal(schema.oneOf[1].maxItems, 64);
  assert.equal(schema.$defs.provider.properties.schemaVersion.const, 4);
});

for (const example of fixture.valid) {
  test(`portable provider normalizes: ${example.name}`, () => {
    assert.deepEqual(normalizeProviderConfig(example.input), example.expected);
  });
}

for (const example of fixture.invalid) {
  test(`portable provider rejects: ${example.name}`, () => {
    assert.throws(() => normalizeProviderConfig(example.input));
  });
}

test("portable import accepts provider, array, and providers document", () => {
  const provider = fixture.valid[0].input;
  assert.deepEqual(providersFromImportDocument(provider), [provider]);
  assert.deepEqual(providersFromImportDocument([provider]), [provider]);
  assert.deepEqual(providersFromImportDocument({ schemaVersion: 4, providers: [provider] }), [provider]);
  assert.throws(() => providersFromImportDocument({ schemaVersion: 4 }), /providers array/);
});
