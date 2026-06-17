import { test } from "node:test";
import assert from "node:assert/strict";

import { diffModels } from "./ollama-cloud-discovery.mjs";

test("reports added (live-only), removed (curated-only), and present", () => {
  const diff = diffModels(
    ["a", "b", "c"], // live on ollama.com
    ["b", "c", "d"], // curated in our catalog
  );
  assert.deepEqual(diff.added, ["a"]);
  assert.deepEqual(diff.removed, ["d"]);
  assert.deepEqual(diff.present, ["b", "c"]);
});

test("output is sorted and de-duplicated", () => {
  const diff = diffModels(["b", "a", "a", "z"], ["b", "b", "m"]);
  assert.deepEqual(diff.added, ["a", "z"]);
  assert.deepEqual(diff.removed, ["m"]);
  assert.deepEqual(diff.present, ["b"]);
});

test("an empty live list marks every curated model as removed (caller must guard)", () => {
  // The wrapper must refuse to act on an empty/failed API response so it never
  // 'discovers' that the whole catalog vanished. The pure diff still reports it.
  const diff = diffModels([], ["a", "b"]);
  assert.deepEqual(diff.removed, ["a", "b"]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.present, []);
});

test("identical lists produce no churn", () => {
  const diff = diffModels(["a", "b"], ["a", "b"]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.present, ["a", "b"]);
});
