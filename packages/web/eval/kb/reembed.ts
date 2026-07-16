// packages/web/eval/kb/reembed.ts
//
// KB eval harness fixture generator (Task 0.4). Embeds every corpus chunk
// (KB_EVAL_CORPUS) and every gold query (GOLD_QUERIES) via bge-m3 and writes
// the result as the committed fixture at corpus/embeddings.json.
//
// Run with: pnpm kb-eval:reembed
//
// Requires a reachable Ollama endpoint with bge-m3 pulled. Defaults to
// http://localhost:11434; override with KB_EVAL_EMBED_URL for a different
// host (e.g. a Docker-networked Ollama container). This mirrors how
// src/app/api/internal/knowledge/search/route.ts resolves its embedder in
// production, except prod reads the admin-configured Ollama URL from the DB
// — this standalone script has no DB connection, so the endpoint comes from
// an env var instead.
//
// Regenerating this fixture is a deliberate, reviewable act: the resulting
// diff to corpus/embeddings.json should be reviewed like any other change to
// committed test data.

import { writeFileSync } from "node:fs";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../src/lib/knowledge/constants";
import { embedTexts } from "../../src/lib/knowledge/embeddings";
import { KB_EVAL_CORPUS } from "./corpus/manifest";
import { GOLD_QUERIES } from "./corpus/gold-queries";
import { EMBEDDINGS_FIXTURE_PATH, type EmbeddingsFixture } from "./embeddings-fixture";

const baseUrl = process.env.KB_EVAL_EMBED_URL ?? "http://localhost:11434";

async function main() {
  // Flatten the corpus into parallel id/text arrays, iterated in the
  // manifest's declaration order — this (not object-key insertion from some
  // intermediate Map) is what makes the written JSON's key order stable
  // across re-runs, so a re-embed with an unchanged model produces a diff
  // that's only float noise, not a reshuffled file.
  const chunkIds: string[] = [];
  const chunkTexts: string[] = [];
  for (const doc of KB_EVAL_CORPUS) {
    for (const chunk of doc.chunks) {
      chunkIds.push(chunk.id);
      chunkTexts.push(chunk.text);
    }
  }

  const queryIds = GOLD_QUERIES.map((q) => q.id);
  const queryTexts = GOLD_QUERIES.map((q) => q.query);

  console.log(
    `Embedding ${chunkTexts.length} corpus chunks + ${queryTexts.length} gold queries ` +
      `via ${EMBEDDING_MODEL} at ${baseUrl}...`
  );

  const embedCfg = {
    baseUrl,
    model: EMBEDDING_MODEL,
    expectedDim: EMBEDDING_DIMENSIONS,
  };

  // Sequential, not Promise.all: keeps load on the embedding endpoint
  // predictable and keeps failure attribution unambiguous (chunks vs.
  // queries) if the endpoint errors partway through.
  const chunkVectors = await embedTexts(chunkTexts, embedCfg);
  const queryVectors = await embedTexts(queryTexts, embedCfg);

  const chunks: Record<string, number[]> = {};
  for (let i = 0; i < chunkIds.length; i++) {
    chunks[chunkIds[i]] = chunkVectors[i];
  }

  const queries: Record<string, number[]> = {};
  for (let i = 0; i < queryIds.length; i++) {
    queries[queryIds[i]] = queryVectors[i];
  }

  const fixture: EmbeddingsFixture = {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIMENSIONS,
    chunks,
    queries,
  };

  writeFileSync(EMBEDDINGS_FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");

  console.log(
    `Wrote ${chunkIds.length} chunk embeddings + ${queryIds.length} query embeddings ` +
      `to ${EMBEDDINGS_FIXTURE_PATH}`
  );
}

void main();
