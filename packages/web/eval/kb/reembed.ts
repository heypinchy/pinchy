// packages/web/eval/kb/reembed.ts
//
// KB eval harness fixture generator (Task 0.4). Embeds every corpus chunk
// (KB_EVAL_CORPUS) and every gold query (GOLD_QUERIES) via the KB's native
// in-process embeddinggemma-300m embedder and writes the result as the
// committed fixture at corpus/embeddings.json — the same embedder production
// uses (kbEmbeddingConfig), so the fixture matches what a real index holds.
//
// Run with: pnpm kb-eval:reembed
//
// Requires the embeddinggemma GGUF on disk. The image bundles it at
// /opt/embedding-models/…; for a local re-embed download it yourself and point
// KB_EMBEDDING_MODEL_PATH at it (see the gated embeddings.local.gguf test for
// the pinned file). No network or Ollama endpoint is involved.
//
// Regenerating this fixture is a deliberate, reviewable act: the resulting
// diff to corpus/embeddings.json should be reviewed like any other change to
// committed test data.

import { writeFileSync } from "node:fs";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../src/lib/knowledge/constants";
import { embedTexts } from "../../src/lib/knowledge/embeddings";
import { kbEmbedderAvailable, kbEmbeddingConfig } from "../../src/lib/knowledge/kb-embedder";
import { KB_EVAL_CORPUS } from "./corpus/manifest";
import { GOLD_QUERIES } from "./corpus/gold-queries";
import { EMBEDDINGS_FIXTURE_PATH, type EmbeddingsFixture } from "./embeddings-fixture";

async function main() {
  if (!kbEmbedderAvailable()) {
    throw new Error(
      "embeddinggemma GGUF not found — set KB_EMBEDDING_MODEL_PATH to a local copy " +
        "(see eval/kb/reembed.ts header) before running pnpm kb-eval:reembed"
    );
  }
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
      `via native ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}-dim, in-process)...`
  );

  const embedCfg = kbEmbeddingConfig();

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
