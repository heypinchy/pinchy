import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validateModelCatalogSnapshot } from "./model-catalog-shape.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SNAPSHOT_PATH = join(
  REPO_ROOT,
  "packages",
  "web",
  "src",
  "lib",
  "model-catalog-snapshot.json",
);

const GOOD_ENTRY = {
  id: "mistral/mistral-large-2512",
  name: "Mistral Large 3",
  family: "mistral-large",
  contextWindow: 262144,
  maxTokens: 262144,
  reasoning: false,
  vision: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("validateModelCatalogSnapshot accepts a well-formed snapshot", () => {
  assert.deepEqual(
    validateModelCatalogSnapshot({ "mistral/mistral-large-2512": GOOD_ENTRY }),
    [],
  );
});

test("validateModelCatalogSnapshot rejects a non-object snapshot", () => {
  assert.equal(validateModelCatalogSnapshot(null).length, 1);
  assert.equal(validateModelCatalogSnapshot([GOOD_ENTRY]).length, 1);
});

test("validateModelCatalogSnapshot rejects an empty snapshot", () => {
  const problems = validateModelCatalogSnapshot({});
  assert.ok(problems.some((p) => /empty/.test(p)));
});

test("validateModelCatalogSnapshot flags a non-positive contextWindow", () => {
  const problems = validateModelCatalogSnapshot({
    m: { ...GOOD_ENTRY, contextWindow: 0 },
  });
  assert.ok(problems.some((p) => /contextWindow/.test(p)));
});

test("validateModelCatalogSnapshot flags a non-numeric maxTokens", () => {
  const problems = validateModelCatalogSnapshot({
    m: { ...GOOD_ENTRY, maxTokens: "lots" },
  });
  assert.ok(problems.some((p) => /maxTokens/.test(p)));
});

test("validateModelCatalogSnapshot flags an empty input array", () => {
  const problems = validateModelCatalogSnapshot({
    m: { ...GOOD_ENTRY, input: [] },
  });
  assert.ok(problems.some((p) => /input/.test(p)));
});

test("validateModelCatalogSnapshot flags a missing cost field", () => {
  const { cacheWrite: _drop, ...partialCost } = GOOD_ENTRY.cost;
  const problems = validateModelCatalogSnapshot({
    m: { ...GOOD_ENTRY, cost: partialCost },
  });
  assert.ok(problems.some((p) => /cost\.cacheWrite/.test(p)));
});

test("validateModelCatalogSnapshot flags a non-numeric cost field", () => {
  const problems = validateModelCatalogSnapshot({
    m: { ...GOOD_ENTRY, cost: { ...GOOD_ENTRY.cost, input: "free" } },
  });
  assert.ok(problems.some((p) => /cost\.input/.test(p)));
});

// The assertion that pins the committed snapshot itself — a bad refresh that
// commits a schema-rejected snapshot fails here, in vitest-adjacent CI, before
// OpenClaw ever silently drops the provider from an agent's catalog.
test("the committed model-catalog snapshot is schema-valid", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  assert.deepEqual(validateModelCatalogSnapshot(snapshot), []);
});
