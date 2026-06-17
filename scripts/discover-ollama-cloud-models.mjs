#!/usr/bin/env node
// Discover drift between the live Ollama Cloud catalog and Pinchy's curated list.
//
// Fetches https://ollama.com/v1/models and compares the served model IDs
// against TOOL_CAPABLE_OLLAMA_CLOUD_MODELS in
// packages/web/src/lib/ollama-cloud-models.ts:
//
//   REMOVED  - a model we curate is no longer served -> stale entry to drop
//              (the llama3.3:70b -> HTTP 404 class of bug). Exits 1 so this is
//              never silent.
//   ADDED    - a served model we don't carry -> candidate. /v1/models has no
//              capability tags, so this list includes chat-only models too;
//              triage each against ollama.com/library/<name> + the tool/vision
//              probes before adding. Informational (does not fail the run).
//
// Why this exists: we otherwise only learn about new models when Ollama emails
// us, and they don't announce every one. This turns "they mentioned GLM-5.2"
// into "here is the full delta."
//
// Usage:
//   OLLAMA_CLOUD_API_KEY=... node scripts/discover-ollama-cloud-models.mjs
//
// Skips with exit 0 if OLLAMA_CLOUD_API_KEY is unset (so CI can run it
// conditionally). Exits 1 on a removed model or an unusable API response.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOllamaCloudModels } from "./lib/ollama-cloud-source.mjs";
import { diffModels } from "./lib/ollama-cloud-discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_TS = resolve(
  __dirname,
  "../packages/web/src/lib/ollama-cloud-models.ts",
);

async function fetchLiveModelIds(apiKey) {
  const res = await fetch("https://ollama.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(
      `GET /v1/models returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m?.id).filter((id) => typeof id === "string");
}

async function main() {
  const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    process.stdout.write(
      "OLLAMA_CLOUD_API_KEY is unset — skipping discover-ollama-cloud-models (exit 0).\n",
    );
    process.exit(0);
  }

  const liveIds = await fetchLiveModelIds(apiKey);
  if (liveIds.length === 0) {
    process.stderr.write(
      "GET /v1/models returned no model IDs — refusing to report the whole catalog as removed.\n",
    );
    process.exit(1);
  }

  const curated = parseOllamaCloudModels(readFileSync(MODELS_TS, "utf8"));
  const curatedIds = curated.map((m) => m.id);
  const { added, removed, present } = diffModels(liveIds, curatedIds);

  // If nothing we curate still appears live, the comparison is almost certainly
  // broken (API shape changed, or IDs now carry a suffix) — not a real mass
  // removal. Bail loudly instead of "discovering" an empty catalog.
  if (present.length === 0 && curatedIds.length > 0) {
    process.stderr.write(
      `None of our ${curatedIds.length} curated models appear in the ${liveIds.length} live IDs. ` +
        "The /v1/models response shape or ID format likely changed — inspect it before trusting this diff.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `Live cloud models: ${liveIds.length} | curated: ${curatedIds.length} | still present: ${present.length}\n\n`,
  );

  if (removed.length > 0) {
    process.stdout.write(
      `REMOVED — ${removed.length} curated model(s) no longer served (drop from ollama-cloud-models.ts):\n`,
    );
    for (const id of removed) process.stdout.write(`  - ${id}\n`);
    process.stdout.write("\n");
  }

  process.stdout.write(
    `ADDED — ${added.length} served model(s) not in our catalog (candidates; /v1/models has no\n` +
      "capability tags, so triage each against ollama.com/library/<name> + the vision/tool probes):\n",
  );
  for (const id of added) process.stdout.write(`  + ${id}\n`);
  process.stdout.write("\n");

  if (removed.length > 0) {
    process.stderr.write(
      `${removed.length} curated model(s) vanished from the live catalog — action required.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("No curated model has been removed upstream.\n");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
