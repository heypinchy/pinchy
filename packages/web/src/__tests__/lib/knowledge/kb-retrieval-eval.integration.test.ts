/**
 * KB Eval Harness Layer 1 — the deterministic retrieval-quality gate.
 *
 * Seeds the frozen synthetic corpus (`eval/kb/corpus/manifest.ts`) into a
 * real PostgreSQL test database with the committed bge-m3 embeddings
 * (`eval/kb/corpus/embeddings.json`), then runs the REAL `retrieve()` — our
 * SQL/RRF hybrid retrieval — against every gold query
 * (`eval/kb/corpus/gold-queries.ts`), scoring recall@10 / MRR / nDCG@10 via
 * `runRetrievalEval`/`aggregate` (`src/lib/eval/kb/retrieval-eval.ts`).
 *
 * The embedder is dependency-injected with a fake that ignores its input and
 * always returns the COMMITTED query embedding for the gold query being
 * scored (`embeddings.queries[<goldQueryId>]`). This removes the embedding
 * MODEL from the gate's loop entirely — a real bge-m3 call is nondeterministic
 * in ways that would make CI flaky, and this gate exists to catch regressions
 * in OUR SQL/RRF/scoping logic, not in the model. `embeddings-drift.test.ts`
 * is the separate guard that keeps the committed fixture honest against the
 * corpus text.
 */
import { expect, it } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { retrieve, type RetrieveDeps } from "@/lib/knowledge/retrieve";
import { aggregate, runRetrievalEval } from "@/lib/eval/kb/retrieval-eval";
import type { CorpusDoc } from "../../../../eval/kb/corpus/manifest";
import { KB_EVAL_CORPUS } from "../../../../eval/kb/corpus/manifest";
import { GOLD_QUERIES } from "../../../../eval/kb/corpus/gold-queries";
import { loadEmbeddings, type EmbeddingsFixture } from "../../../../eval/kb/embeddings-fixture";
import type { GoldQuery } from "@/lib/eval/kb/types";

const ORG_ID = "org-kb-eval";

/**
 * Floors chosen from OBSERVED aggregate + per-axis numbers on this frozen
 * corpus + committed bge-m3 fixture (`KB_EVAL_VERBOSE=1 pnpm test:db ...`
 * prints the same JSON this comment is transcribed from), rounded DOWN and
 * set strictly BELOW observed so the gate trips on a real regression but
 * tolerates normal noise (e.g. an HNSW `ef_search` tweak nudging candidate
 * order by one rank).
 *
 * Observed aggregate (n=24): recallAt10 = 1.0, mrr = 0.9167, ndcgAt10 = 0.9385.
 *
 * Observed per-axis (n=4 each):
 *   happy         recall 1.0  mrr 1.0   ndcg 1.0
 *   path-citation recall 1.0  mrr 0.75  ndcg 0.8155
 *   dedup         recall 1.0  mrr 1.0   ndcg 1.0
 *   multi-hop     recall 1.0  mrr 1.0   ndcg 1.0
 *   distractor    recall 1.0  mrr 1.0   ndcg 1.0
 *   cross-lingual recall 1.0  mrr 0.75  ndcg 0.8155
 *
 * recall@10 is a perfect 1.0 on EVERY axis, including cross-lingual — bge-m3
 * bridges DE/EN cleanly on this corpus, so there is no cross-lingual retrieval
 * gap to flag. path-citation and cross-lingual are the only two axes below a
 * perfect MRR (both 0.75): the relevant chunk is always recalled, just not
 * always ranked strictly first (a same-topic sibling chunk edges into rank 1
 * on some queries). Expected noise on those harder axes, not a correctness
 * bug: recall is perfect, so nothing relevant is ever missed, only sometimes
 * out-ranked.
 *
 * WHY per-axis floors matter (this is what gives the gate teeth): a ranking
 * regression confined to ONE axis — a relevant chunk still recalled in top-10
 * but shoved from rank 1 to rank 5+ — barely moves the n=24 aggregate MRR and
 * would slip past an aggregate-only assertion. Asserting a per-axis MRR floor
 * on every axis catches a single-axis collapse the aggregate hides.
 *
 * Floor derivation (all strictly below the corresponding observed minimum):
 *   RECALL_FLOOR         = 0.9   (observed aggregate + per-axis min both 1.0)
 *   MRR_FLOOR            = 0.7   (observed aggregate 0.9167)
 *   NDCG_FLOOR           = 0.85  (observed aggregate 0.9385)
 *   PER_AXIS_RECALL_FLOOR= 0.9   (observed per-axis min 1.0)
 *   PER_AXIS_MRR_FLOOR   = 0.6   (observed per-axis min 0.75, on path-citation
 *                                 & cross-lingual; 0.6 leaves headroom below)
 */
const RECALL_FLOOR = 0.9;
const MRR_FLOOR = 0.7;
const NDCG_FLOOR = 0.85;
const PER_AXIS_RECALL_FLOOR = 0.9;
const PER_AXIS_MRR_FLOOR = 0.6;

/**
 * Seeds the corpus and returns the mapping from the manifest's stable
 * logical chunk id (e.g. "it-equipment-policy#c1", what `GoldQuery.
 * relevantChunkIds` reference) to the DB-generated `kb_chunks.id` UUID that
 * `retrieve()` actually returns — the two are seeded 1:1 but are NOT the
 * same string, so scoring needs this map to translate retrieved DB ids back
 * to logical ids before comparing against the gold set.
 */
async function seedCorpus(
  corpus: CorpusDoc[],
  embeddings: EmbeddingsFixture
): Promise<Map<string, string>> {
  const logicalIdByDbId = new Map<string, string>();

  for (const doc of corpus) {
    const [dbDoc] = await db
      .insert(kbDocuments)
      .values({
        orgId: ORG_ID,
        contentHash: `hash-${doc.sourcePath}`,
        sourcePath: doc.sourcePath,
        status: "active",
      })
      .returning();

    for (const chunk of doc.chunks) {
      const embedding = embeddings.chunks[chunk.id];
      if (!embedding) {
        throw new Error(`Missing embedding fixture for chunk id ${chunk.id}`);
      }
      const [dbChunk] = await db
        .insert(kbChunks)
        .values({
          documentId: dbDoc.id,
          orgId: ORG_ID,
          sourcePath: doc.sourcePath,
          chunkText: chunk.text,
          page: chunk.page,
          embedding,
        })
        .returning();
      logicalIdByDbId.set(dbChunk.id, chunk.id);
    }
  }

  return logicalIdByDbId;
}

/** Fake embedder that always returns the committed query embedding for `q`, ignoring input text. */
function embedderFor(q: GoldQuery, embeddings: EmbeddingsFixture): RetrieveDeps {
  const queryVector = embeddings.queries[q.id];
  if (!queryVector) {
    throw new Error(`Missing embedding fixture for gold query id ${q.id}`);
  }
  return { embed: async (texts: string[]) => texts.map(() => queryVector) };
}

it("achieves recall@10 and MRR floors over the gold set", async () => {
  const embeddings = loadEmbeddings();
  const logicalIdByDbId = await seedCorpus(KB_EVAL_CORPUS, embeddings);

  const retrievalFn = async (q: GoldQuery): Promise<string[]> => {
    const deps = embedderFor(q, embeddings);
    const results = await retrieve(ORG_ID, ["/data"], q.query, deps, { k: 10 });
    return results.map((r) => {
      const logicalId = logicalIdByDbId.get(r.chunkId);
      if (!logicalId) {
        throw new Error(`retrieve() returned unseeded chunk id ${r.chunkId}`);
      }
      return logicalId;
    });
  };

  const scores = await runRetrievalEval(GOLD_QUERIES, retrievalFn);
  const agg = aggregate(scores);

  if (process.env.KB_EVAL_VERBOSE) {
    console.log("KB eval Layer-1 aggregate:", JSON.stringify(agg, null, 2));
  }

  // Aggregate floors.
  expect(agg.recallAt10).toBeGreaterThanOrEqual(RECALL_FLOOR);
  expect(agg.mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  expect(agg.ndcgAt10).toBeGreaterThanOrEqual(NDCG_FLOOR);

  // Per-axis floors: the aggregate can stay high while one axis quietly
  // regresses (a relevant chunk shoved from rank 1 to rank 5+ within top-10).
  // Assert EVERY axis clears its floor so a single-axis collapse can't hide.
  for (const [axis, score] of Object.entries(agg.perAxis)) {
    if (score.n === 0) continue; // no queries on this axis today, but guard it
    expect(
      score.recallAt10,
      `axis ${axis}: recall@10 ${score.recallAt10} below floor ${PER_AXIS_RECALL_FLOOR}`
    ).toBeGreaterThanOrEqual(PER_AXIS_RECALL_FLOOR);
    expect(
      score.mrr,
      `axis ${axis}: MRR ${score.mrr} below floor ${PER_AXIS_MRR_FLOOR}`
    ).toBeGreaterThanOrEqual(PER_AXIS_MRR_FLOOR);
  }
});
