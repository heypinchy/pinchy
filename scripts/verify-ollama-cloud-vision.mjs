#!/usr/bin/env node
// Verify Pinchy's curated Ollama Cloud vision flags against the live API.
//
// For each model in packages/web/src/lib/ollama-cloud-models.ts this script
// POSTs the pinned fixture image (scripts/lib/vision-probe-fixture.png — a
// 4-digit number and a coloured circle) to
// https://ollama.com/v1/chat/completions and compares what comes back against
// the model's `vision` flag. Any disagreement exits 1.
//
// Why this exists: ollama.com/library/<name> pages claim "Text, Image" for
// models whose runtime API rejects images (e.g. devstral-small-2:24b — see
// #416). The library metadata cannot be trusted; this script tests the
// strict layer (live API) directly.
//
// Two things this probe learned the hard way, both encoded in the classifier
// (scripts/lib/ollama-cloud-vision-probe.mjs) rather than in a comment nobody
// reads at 2am:
//
//  1. HTTP 200 is NOT proof of sight. A model can accept an image and invent
//     its contents — qwen3.5:397b did that for a month. So the fixture carries
//     a number and the check is whether the model reports it.
//  2. A probe's own fixture can rot. The 64x64 PNG used until 2026-07-30
//     became undecodable to Ollama's backends and the sweep reported six of
//     eighteen models as vision drift; following that report would have
//     flipped six correct flags. A decode complaint is now its own verdict
//     ("fixture-rejected") and never a model verdict.
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
import { isTransientStatus } from "./lib/ollama-cloud-tool-probe.mjs";
import {
  buildVisionProbeRequest,
  classifyVisionResponse,
} from "./lib/ollama-cloud-vision-probe.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_TS = resolve(
  __dirname,
  "../packages/web/src/lib/ollama-cloud-models.ts",
);

// 512x512 PNG: a blue circle and the number 7413 in a bold sans face. Pinned as
// a file rather than a base64 literal because it is 10KB of binary that no
// reviewer benefits from scrolling past. Ground truth lives beside the
// classifier in lib/ollama-cloud-vision-probe.mjs — change one and you must
// change the other.
//
// Size is load-bearing. The 4x4 predecessor tripped minimum-size guards, its
// 64x64 replacement was refused outright by 2026-07, and the digits have to
// survive whatever downscaling a provider applies. Regenerating? Keep it well
// above 256x256 and re-run the whole sweep, not just one model.
const FIXTURE_PNG = resolve(__dirname, "lib/vision-probe-fixture.png");
const TEST_IMAGE_DATA_URL = `data:image/png;base64,${readFileSync(FIXTURE_PNG).toString("base64")}`;

// gemma4:31b HTTP 500s on roughly half its image requests (observed 2026-07-30)
// while answering correctly the rest of the time. Without a retry the sweep
// reports a real vision model as broken every other run, which is how a gate
// trains people to ignore it.
const MAX_ATTEMPTS = 4;

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
  const body = buildVisionProbeRequest(id, TEST_IMAGE_DATA_URL);

  let last;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://ollama.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      last = { status: res.status, body: text, attempts: attempt };
      if (!isTransientStatus(res.status)) return last;
    } catch (err) {
      // A dropped connection is exactly as transient as the 503 above and gets
      // the same retries. Without this the drift report tells you a model "gave
      // no usable answer after 4 attempts" when a single ECONNRESET was all that
      // happened — a diagnostic that sends you looking at the model instead of
      // the network. `last` is deliberately NOT cleared: a real HTTP response
      // from an earlier attempt is more informative than a later socket error.
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
  }
  if (!last) throw lastError;
  return last;
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
        verdict: "network-error",
        detail: err.message,
      });
      continue;
    }

    const { verdict, detail } = classifyVisionResponse({
      flag: model.vision,
      status: result.status,
      body: result.body,
    });
    const retried =
      result.attempts > 1 ? ` after ${result.attempts} attempts` : "";

    if (verdict === "ok") {
      process.stdout.write(`OK (${detail})${retried}\n`);
      continue;
    }

    process.stdout.write(`${verdict.toUpperCase()} — ${detail}${retried}\n`);
    drift.push({
      id: model.id,
      flag: model.vision,
      verdict,
      detail,
      status: result.status,
      attempts: result.attempts,
      bodySnippet: result.body.slice(0, 200),
    });
  }

  if (drift.length > 0) {
    process.stderr.write("\n=== DRIFT REPORT ===\n");
    process.stderr.write(JSON.stringify(drift, null, 2) + "\n");

    // Separate the two remedies. Only a real flag disagreement is an argument
    // for editing the catalog; a refused fixture or a persistent 5xx is not,
    // and conflating them is how a rotten fixture turns into six wrong flags.
    const flagDrift = drift.filter((d) => d.verdict === "drift");
    const ours = drift.filter((d) => d.verdict === "fixture-rejected");
    const unclear = drift.filter(
      (d) => d.verdict === "unexpected" || d.verdict === "network-error",
    );

    if (flagDrift.length > 0) {
      process.stderr.write(
        `\n${flagDrift.length} model(s) disagree with their flag: ` +
          `${flagDrift.map((d) => d.id).join(", ")}. ` +
          "Fix flags in packages/web/src/lib/ollama-cloud-models.ts.\n",
      );
    }
    if (ours.length > 0) {
      process.stderr.write(
        `\n${ours.length} provider(s) refused the probe fixture: ` +
          `${ours.map((d) => d.id).join(", ")}. ` +
          "This is OUR bug — regenerate scripts/lib/vision-probe-fixture.png. " +
          "Do NOT change any catalog flag on this evidence.\n",
      );
    }
    if (unclear.length > 0) {
      process.stderr.write(
        `\n${unclear.length} model(s) gave no usable answer after ${MAX_ATTEMPTS} ` +
          `attempts: ${unclear.map((d) => d.id).join(", ")}. ` +
          "Server-side or transport fault — re-run before concluding anything.\n",
      );
    }
    process.exit(1);
  }

  process.stdout.write(`\nAll ${targets.length} model(s) match runtime API.\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
