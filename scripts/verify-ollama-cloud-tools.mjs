#!/usr/bin/env node
// Verify Pinchy's curated Ollama Cloud models still emit structured tool calls.
//
// Every model in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS is, by its name, expected to
// be tool-capable. For each one this script POSTs a function-tool probe to
// https://ollama.com/v1/chat/completions across TWO rounds: round 1 must carry
// a structured `tool_calls` array, and a round-2 follow-up (the same history
// plus a tool result) must return HTTP 200. A model is reported as drift if it
// returns empty content (qwen3-next's failure mode), leaks the call as plain
// text (gemini-3-flash-preview's `default_api` signature), or HTTP 500s on the
// follow-up once the history carries a tool result (gemma3 / kimi-k2-thinking).
// Every Pinchy agent runs multi-turn tool loops, so a model that fails any of
// these must not be surfaced as tool-capable.
//
// NOTE: a single passing run is a smoke test, not a reliability proof — some
// models are intermittent (qwen3-next 3/4, gemma3 flip-flopped between days).
// Run the probe several times before trusting a NEW addition.
//
// This is the tool-calling sibling of verify-ollama-cloud-vision.mjs. The
// request shape and response classifier live in
// scripts/lib/ollama-cloud-tool-probe.mjs and are unit-tested; this wrapper is
// the thin network layer.
//
// Usage:
//   OLLAMA_CLOUD_API_KEY=... node scripts/verify-ollama-cloud-tools.mjs
//   OLLAMA_CLOUD_API_KEY=... node scripts/verify-ollama-cloud-tools.mjs --only=glm-5.2
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
import {
  buildToolProbeRequest,
  buildToolFollowupRequest,
  classifyToolResponse,
  isTransientStatus,
} from "./lib/ollama-cloud-tool-probe.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_TS = resolve(
  __dirname,
  "../packages/web/src/lib/ollama-cloud-models.ts",
);

function parseArgs(argv) {
  const args = { only: null };
  for (const a of argv) {
    if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
  }
  return args;
}

async function postChat(body, apiKey, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    last = { status: res.status, body: text, parsed };
    // Retry only infra noise (overload/5xx). 200 and capability errors are final.
    if (!isTransientStatus(res.status)) return last;
    await sleep(3000 + i * 2000);
  }
  return last; // exhausted retries — still transient
}

// Probe a model across two rounds. A model is only OK if it emits a structured
// tool_call AND survives the multi-turn follow-up (HTTP 200 once the history
// carries a tool result). Single-turn alone is a false-positive trap: gemma3
// emits a clean single-turn call but HTTP 500s on the follow-up, which is why
// gemma3 stays out of the catalog (see ollama-cloud-models.test.ts).
async function probeModel(id, apiKey) {
  // Re-assert the safe-ID allowlist right at the network sink. The shared
  // parser already validates, but co-locating the barrier with the fetch keeps
  // the file-data -> outbound-request dataflow provably sanitized for CodeQL.
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(
      `verify-ollama-cloud-tools: refusing to send unsafe model id "${id}" to the API.`,
    );
  }

  const r1 = await postChat(buildToolProbeRequest(id), apiKey);
  if (r1.status !== 200 || !r1.parsed) {
    // Overload that outlived the retries isn't a capability verdict.
    const stage = isTransientStatus(r1.status) ? "inconclusive" : "round1-http";
    return { stage, status: r1.status, body: r1.body };
  }
  const verdict = classifyToolResponse(r1.parsed);
  if (!verdict.supportsTools) {
    return { stage: "round1-verdict", verdict, body: r1.body };
  }

  const assistantMessage = r1.parsed.choices[0].message;
  const r2 = await postChat(
    buildToolFollowupRequest(id, assistantMessage),
    apiKey,
  );
  if (r2.status !== 200) {
    const stage = isTransientStatus(r2.status) ? "inconclusive" : "round2-fail";
    return { stage, status: r2.status, r2status: r2.status, body: r2.body };
  }
  return { stage: "ok", detail: verdict.detail };
}

async function main() {
  const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    process.stdout.write(
      "OLLAMA_CLOUD_API_KEY is unset — skipping verify-ollama-cloud-tools (exit 0).\n",
    );
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const all = parseOllamaCloudModels(readFileSync(MODELS_TS, "utf8"));
  const targets = args.only ? all.filter((m) => m.id === args.only) : all;
  if (targets.length === 0) {
    process.stderr.write(`No models matched --only=${args.only}\n`);
    process.exit(1);
  }

  const drift = [];
  const inconclusive = [];
  for (const model of targets) {
    process.stdout.write(`testing ${model.id}… `);
    let result;
    try {
      result = await probeModel(model.id, apiKey);
    } catch (err) {
      process.stdout.write(`NETWORK ERROR: ${err.message}\n`);
      drift.push({
        id: model.id,
        actual: "network-error",
        detail: err.message,
      });
      continue;
    }

    if (result.stage === "ok") {
      process.stdout.write(`OK (${result.detail} + clean multi-turn)\n`);
      continue;
    }

    if (result.stage === "inconclusive") {
      // Overload outlived the retries — NOT a verdict. Never report "remove".
      process.stdout.write(
        `SKIP (infra: HTTP ${result.status}, retry later)\n`,
      );
      inconclusive.push({ id: model.id, status: result.status });
      continue;
    }

    if (result.stage === "round1-http") {
      process.stdout.write(`DRIFT (round 1 HTTP ${result.status})\n`);
      drift.push({
        id: model.id,
        stage: result.stage,
        status: result.status,
        bodySnippet: result.body.slice(0, 200),
      });
      continue;
    }

    if (result.stage === "round1-verdict") {
      process.stdout.write(
        `DRIFT (${result.verdict.leakedAsText ? "leaked as text" : "no tool call"})\n`,
      );
      drift.push({
        id: model.id,
        stage: result.stage,
        leakedAsText: result.verdict.leakedAsText,
        detail: result.verdict.detail,
        bodySnippet: result.body.slice(0, 200),
      });
      continue;
    }

    // round2-fail: clean single-turn call but the follow-up broke — the gemma3
    // multi-turn failure mode. Every Pinchy agent runs multi-turn tool loops.
    process.stdout.write(`DRIFT (multi-turn HTTP ${result.r2status})\n`);
    drift.push({
      id: model.id,
      stage: result.stage,
      r2status: result.r2status,
      bodySnippet: result.body.slice(0, 200),
    });
  }

  if (inconclusive.length > 0) {
    // Surfaced loudly so an overloaded run is never silently read as "all pass".
    process.stderr.write(
      `\nINCONCLUSIVE — ${inconclusive.length} model(s) only returned infra errors (overload) ` +
        `after retries; re-run later: ${inconclusive.map((m) => m.id).join(", ")}\n`,
    );
  }

  if (drift.length > 0) {
    process.stderr.write("\n=== DRIFT REPORT ===\n");
    process.stderr.write(JSON.stringify(drift, null, 2) + "\n");
    process.stderr.write(
      `\n${drift.length} model(s) no longer emit clean tool calls. ` +
        "Remove them from packages/web/src/lib/ollama-cloud-models.ts.\n",
    );
    process.exit(1);
  }

  const verified = targets.length - inconclusive.length;
  process.stdout.write(
    `\n${verified}/${targets.length} model(s) verified tool-capable` +
      (inconclusive.length > 0
        ? ` (${inconclusive.length} inconclusive — see above).\n`
        : ".\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
