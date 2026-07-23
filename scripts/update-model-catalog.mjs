#!/usr/bin/env node
// Refreshes packages/web/src/lib/model-catalog-snapshot.json from models.dev
// (MIT-licensed). Run at release time; commit the result. Offline-first: the
// committed snapshot is the only runtime source — nothing fetches at runtime.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "web",
  "src",
  "lib",
  "model-catalog-snapshot.json",
);

const res = await fetch("https://models.dev/models.json");
if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
const raw = await res.json();

// models.json is keyed by canonical model id. Slim each entry to the fields
// OpenClaw's ModelDefinitionConfig needs. Skip entries missing a context limit.
const out = {};
for (const [id, m] of Object.entries(raw)) {
  const ctx = m.limit?.context;
  if (!ctx) continue;
  const visionIn =
    Array.isArray(m.modalities?.input) && m.modalities.input.includes("image");
  out[id] = {
    id,
    name: m.name ?? id,
    family: m.family ?? id,
    contextWindow: ctx,
    maxTokens: m.limit?.output ?? 8192,
    reasoning: Boolean(m.reasoning),
    vision: visionIn,
    input: visionIn ? ["text", "image"] : ["text"],
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cache_read ?? 0,
      cacheWrite: m.cost?.cache_write ?? 0,
    },
  };
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${Object.keys(out).length} models to ${OUT}`);
