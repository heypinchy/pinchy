import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseOllamaCloudModels,
  MODEL_ID_PATTERN,
} from "./ollama-cloud-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_SOURCE = resolve(
  __dirname,
  "../../packages/web/src/lib/ollama-cloud-models.ts",
);

const FIXTURE = `
export const TOOL_CAPABLE_OLLAMA_CLOUD_MODELS = [
  {
    // a stray comment containing id: "fake-from-comment" that must be ignored
    id: "glm-5.2",
    contextWindow: 202752,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  },
  {
    /* block comment with vision: true buried inside it */
    id: "qwen3-vl:235b-instruct",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  },
] as const satisfies readonly OllamaCloudModel[];
`;

test("parses every field for each entry", () => {
  const models = parseOllamaCloudModels(FIXTURE);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    id: "glm-5.2",
    contextWindow: 202752,
    maxTokens: 8192,
    reasoning: true,
    vision: false,
  });
  assert.deepEqual(models[1], {
    id: "qwen3-vl:235b-instruct",
    contextWindow: 262144,
    maxTokens: 8192,
    reasoning: true,
    vision: true,
  });
});

test("ignores id- and flag-looking text inside comments", () => {
  const models = parseOllamaCloudModels(FIXTURE);
  assert.ok(!models.some((m) => m.id === "fake-from-comment"));
  // The block comment's `vision: true` must not flip the real flag.
  assert.equal(models[0].vision, false);
});

test("throws on a model id that fails the safe allowlist", () => {
  const bad = `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS = [
    { id: "EVIL ID; rm -rf", contextWindow: 1, maxTokens: 1, reasoning: false, vision: false },
  ]`;
  assert.throws(() => parseOllamaCloudModels(bad), /allowlist/i);
});

test("throws when no entries are found", () => {
  assert.throws(
    () => parseOllamaCloudModels("const unrelated = 1;"),
    /no model entries/i,
  );
});

test("MODEL_ID_PATTERN accepts real ollama ids and rejects unsafe ones", () => {
  assert.ok(MODEL_ID_PATTERN.test("qwen3-vl:235b-instruct"));
  assert.ok(MODEL_ID_PATTERN.test("deepseek-v3.1:671b"));
  assert.ok(MODEL_ID_PATTERN.test("gpt-oss:120b"));
  assert.ok(!MODEL_ID_PATTERN.test("Evil Id"));
  assert.ok(!MODEL_ID_PATTERN.test("ollama-cloud/glm-4.7")); // no slashes — prefix is added elsewhere
});

test("parses the real curated source and finds a known model with correct fields", () => {
  const models = parseOllamaCloudModels(readFileSync(REAL_SOURCE, "utf8"));
  const glm = models.find((m) => m.id === "glm-4.7");
  assert.ok(glm, "glm-4.7 should be present in the real catalog");
  assert.equal(glm.contextWindow, 202752);
  assert.equal(glm.reasoning, true);
  assert.equal(glm.vision, false);
  // Catch a parser that silently matches only the first entry.
  assert.ok(
    models.length >= 25,
    `expected the full catalog, parsed ${models.length}`,
  );
});
