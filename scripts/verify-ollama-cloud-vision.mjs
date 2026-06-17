#!/usr/bin/env node
// Verify Pinchy's curated Ollama Cloud vision flags against the live API.
//
// For each model flagged `vision: true` in
// packages/web/src/lib/ollama-cloud-models.ts, this script POSTs a tiny test
// image to https://ollama.com/v1/chat/completions and asserts the response
// is HTTP 200. For each `vision: false` model, it asserts the response is
// HTTP 4xx with the "image input is not enabled" signal. Any mismatch
// exits 1.
//
// Why this exists: ollama.com/library/<name> pages claim "Text, Image" for
// models whose runtime API rejects images (e.g. devstral-small-2:24b — see
// #416). The library metadata cannot be trusted; this script tests the
// strict layer (live API) directly.
//
// Usage:
//   OLLAMA_CLOUD_API_KEY=... node scripts/verify-ollama-cloud-vision.mjs
//   OLLAMA_CLOUD_API_KEY=... node scripts/verify-ollama-cloud-vision.mjs --only=qwen3-vl:235b
//
// Exits 0 on full agreement, 1 on any drift. Skips with exit 0 if
// OLLAMA_CLOUD_API_KEY is unset (so CI can run it conditionally).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseOllamaCloudModels,
  MODEL_ID_PATTERN,
} from "./lib/ollama-cloud-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_TS = resolve(
  __dirname,
  "../packages/web/src/lib/ollama-cloud-models.ts",
);

// 64×64 solid-red PNG (base64). Small but big enough that vision pipelines
// with minimum-image-size guards (e.g. gemini-3-flash-preview's "Unable to
// process input image" on 4×4) still accept it. Generated once and pinned.
const TEST_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQ0lEQVR4nO3OQQ0AAAjAMOZf9DCAj1QQ" +
  "OPe8Sgl8L4DEAAhAACAAEYAARAACEAEIQAQgABGAAEQAAhABCEAEIAARgABEAALwGwOcXgABolNDOgAAAABJRU5ErkJggg==";
const TEST_IMAGE_DATA_URL = `data:image/png;base64,${TEST_IMAGE_PNG_BASE64}`;

const NOT_SUPPORTED_PATTERNS = [
  /image input is not enabled/i,
  /this model does not support image input/i,
  /does not support images/i,
];

function parseArgs(argv) {
  const args = { only: null };
  for (const a of argv) {
    if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
  }
  return args;
}

async function testModel(id, apiKey) {
  // Re-assert the safe-ID allowlist right at the network sink. The shared
  // parser already validates, but co-locating the barrier with the fetch keeps
  // the file-data -> outbound-request dataflow provably sanitized for CodeQL.
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(
      `verify-ollama-cloud-vision: refusing to send unsafe model id "${id}" to the API.`,
    );
  }
  const body = {
    model: id,
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What color is this image? Respond with one word.",
          },
          { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } },
        ],
      },
    ],
  };
  const res = await fetch("https://ollama.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

function bodyRejectsImage(bodyText) {
  return NOT_SUPPORTED_PATTERNS.some((re) => re.test(bodyText));
}

async function main() {
  const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    process.stdout.write(
      "OLLAMA_CLOUD_API_KEY is unset — skipping verify-ollama-cloud-vision (exit 0).\n",
    );
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const source = readFileSync(MODELS_TS, "utf8");
  const all = parseOllamaCloudModels(source);
  const targets = args.only ? all.filter((m) => m.id === args.only) : all;
  if (targets.length === 0) {
    process.stderr.write(`No models matched --only=${args.only}\n`);
    process.exit(1);
  }

  const drift = [];
  for (const model of targets) {
    process.stdout.write(
      `testing ${model.id} (flag: vision=${model.vision})… `,
    );
    let result;
    try {
      result = await testModel(model.id, apiKey);
    } catch (err) {
      process.stdout.write(`NETWORK ERROR: ${err.message}\n`);
      drift.push({
        id: model.id,
        flag: model.vision,
        actual: "network-error",
        detail: err.message,
      });
      continue;
    }

    const apiAccepts = result.status === 200;
    const apiRejectsImage =
      result.status >= 400 && bodyRejectsImage(result.body);

    if (model.vision && apiAccepts) {
      process.stdout.write("OK (api accepts)\n");
      continue;
    }
    if (!model.vision && apiRejectsImage) {
      process.stdout.write("OK (api rejects)\n");
      continue;
    }
    if (!model.vision && result.status === 200) {
      // The model is marked text-only but the API actually accepts images.
      // Could be a candidate for promotion, but the flag side is conservative
      // — flag this so a human decides.
      process.stdout.write("DRIFT (flag=false but API accepts)\n");
    } else if (model.vision && apiRejectsImage) {
      process.stdout.write("DRIFT (flag=true but API rejects images)\n");
    } else {
      process.stdout.write(`UNEXPECTED status=${result.status}\n`);
    }
    drift.push({
      id: model.id,
      flag: model.vision,
      status: result.status,
      bodySnippet: result.body.slice(0, 200),
    });
  }

  if (drift.length > 0) {
    process.stderr.write("\n=== DRIFT REPORT ===\n");
    process.stderr.write(JSON.stringify(drift, null, 2) + "\n");
    process.stderr.write(
      `\n${drift.length} model(s) drift from runtime API. ` +
        "Fix flags in packages/web/src/lib/ollama-cloud-models.ts.\n",
    );
    process.exit(1);
  }

  process.stdout.write(`\nAll ${targets.length} model(s) match runtime API.\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
