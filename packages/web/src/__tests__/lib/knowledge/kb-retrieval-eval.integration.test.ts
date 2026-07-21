/**
 * KB Eval Harness Layer 1 — the deterministic retrieval-quality gate.
 *
 * Seeds the frozen synthetic corpus (`eval/kb/corpus/manifest.ts`) into a
 * real PostgreSQL test database with the committed embeddinggemma-300m embeddings
 * (`eval/kb/corpus/embeddings.json`), then runs the REAL `retrieve()` — our
 * SQL/RRF hybrid retrieval — against every gold query
 * (`eval/kb/corpus/gold-queries.ts`), scoring recall@10 / MRR / nDCG@10 via
 * `runRetrievalEval`/`aggregate` (`src/lib/eval/kb/retrieval-eval.ts`).
 *
 * The embedder is dependency-injected with a fake that ignores its input and
 * always returns the COMMITTED query embedding for the gold query being
 * scored (`embeddings.queries[<goldQueryId>]`). This removes the embedding
 * MODEL from the gate's loop entirely — a real embeddinggemma-300m call is nondeterministic
 * in ways that would make CI flaky, and this gate exists to catch regressions
 * in OUR SQL/RRF/scoping logic, not in the model. `embeddings-drift.test.ts`
 * is the separate guard that keeps the committed fixture honest against the
 * corpus text.
 *
 * This IS the gate — no separate CI job. As an `*.integration.test.ts` under
 * `src/`, it is picked up by `pnpm test:db` (vitest.integration.config.ts's
 * `src/**` include) and therefore runs in the required `vitest-integration` CI
 * job against a pgvector Postgres service. A PR that regresses recall@10 / MRR
 * / nDCG@10 below the floors below (overall or per-axis) turns that required
 * check red and cannot merge — the "regression-protected retrieval" product
 * promise made literal for the deterministic half. See
 * docs/plans/2026-07-16-kb-eval-harness.md, Milestone 1 / Task 1.6.
 */
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { retrieve, type RetrieveDeps } from "@/lib/knowledge/retrieve";
import { statusForPath } from "@/lib/knowledge/archive-paths";
import {
  aggregate,
  nearDuplicateSourcePaths,
  runRetrievalEval,
} from "@/lib/eval/kb/retrieval-eval";
import type { CorpusDoc } from "../../../../eval/kb/corpus/manifest";
import { KB_EVAL_CORPUS } from "../../../../eval/kb/corpus/manifest";
import { GOLD_QUERIES } from "../../../../eval/kb/corpus/gold-queries";
import { loadEmbeddings, type EmbeddingsFixture } from "../../../../eval/kb/embeddings-fixture";
import type { GoldQuery } from "@/lib/eval/kb/types";

const ORG_ID = "org-kb-eval";

/**
 * Floors chosen from OBSERVED aggregate + per-axis numbers on this frozen
 * corpus + committed embeddinggemma-300m fixture (`KB_EVAL_VERBOSE=1 pnpm test:db ...`
 * prints the same JSON this comment is transcribed from), rounded DOWN and
 * set strictly BELOW observed so the gate trips on a real regression but
 * tolerates normal noise (e.g. an HNSW `ef_search` tweak nudging candidate
 * order by one rank).
 *
 * Observed aggregate (n=32): recallAt10 = 1.0, mrr = 0.9375, ndcgAt10 = 0.9539.
 *
 * Observed per-axis (n=4 each):
 *   happy         recall 1.0  mrr 1.0   ndcg 1.0
 *   path-citation recall 1.0  mrr 0.75  ndcg 0.8155
 *   dedup         recall 1.0  mrr 1.0   ndcg 1.0
 *   multi-hop     recall 1.0  mrr 1.0   ndcg 1.0
 *   distractor    recall 1.0  mrr 1.0   ndcg 1.0
 *   cross-lingual recall 1.0  mrr 0.75  ndcg 0.8155
 *   freshness     recall 1.0  mrr 1.0   ndcg 1.0
 *   crowding      recall 1.0  mrr 1.0   ndcg 1.0
 *
 * recall@10 is a perfect 1.0 on EVERY axis, including cross-lingual — embeddinggemma-300m
 * bridges DE/EN cleanly on this corpus, so there is no cross-lingual retrieval
 * gap to flag. path-citation and cross-lingual are the only two axes below a
 * perfect MRR (both 0.75): the relevant chunk is always recalled, just not
 * always ranked strictly first (a same-topic sibling chunk edges into rank 1
 * on some queries). Expected noise on those harder axes, not a correctness
 * bug: recall is perfect, so nothing relevant is ever missed, only sometimes
 * out-ranked.
 *
 * freshness (#858) scores a perfect 1.0 because the archived 2013 cert is
 * seeded `archived` (via statusForPath, so this exercises the real ingest
 * wiring) and default retrieval excludes it — leaving only the current cert
 * to recall and rank. crowding (#858) scores 1.0 because the per-document cap
 * keeps the compilation binder from displacing the clean datasheet. The two
 * behavioral describe blocks below assert those two mechanisms directly
 * (archived-exclusion + opt-in; per-document cap), which is what gives these
 * axes teeth beyond the numeric floors.
 *
 * WHY per-axis floors matter (this is what gives the gate teeth): a ranking
 * regression confined to ONE axis — a relevant chunk still recalled in top-10
 * but shoved from rank 1 to rank 5+ — barely moves the n=32 aggregate MRR and
 * would slip past an aggregate-only assertion. Asserting a per-axis MRR floor
 * on every axis catches a single-axis collapse the aggregate hides.
 *
 * Floor derivation (all strictly below the corresponding observed minimum):
 *   RECALL_FLOOR         = 0.9   (observed aggregate + per-axis min both 1.0)
 *   MRR_FLOOR            = 0.7   (observed aggregate 0.9375)
 *   NDCG_FLOOR           = 0.85  (observed aggregate 0.9539)
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
        // Derive the seed status from the real archive rule so the freshness
        // axis exercises the actual ingest wiring (statusForPath), not a
        // hand-set status: the OLD/ cert lands `archived` exactly as a real
        // ingest would mark it.
        status: statusForPath(doc.sourcePath),
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

describe("dedup axis — cross-path provenance is preserved, not collapsed", () => {
  // WHY THIS IS NOT A COLLAPSE GATE (read before "fixing" this into one):
  //
  // `kb_documents` are keyed by `(org_id, source_path)` — see db/schema.ts's
  // `uq_kb_doc_org_path` comment: "two different paths with byte-identical
  // content ... are DISTINCT documents, which per-path allowed_paths
  // filtering requires; cross-path content dedup would break that
  // filtering." That's an intentional access-control decision: an org can
  // grant an agent /data/product-insert.md without granting
  // /data/quality-file.md (or vice versa), so retrieval MUST keep
  // near-duplicate passages from different paths independently retrievable.
  // Collapsing them into one canonical source here would silently strip
  // access-control granularity from whichever path "lost" the collapse.
  //
  // The invariant under test below is therefore PROVENANCE (both source
  // paths stay retrievable), not attribution. "Don't let a reworded
  // duplicate look like independent corroboration" is a real concern, but it
  // belongs to the attribution layer — Layer 2 / Task 2.1 — which judges
  // what the LLM actually CITES in its answer, not what retrieve() returns.
  // "Near-duplicate rate in retrieved chunks" is tracked as a metric
  // (telemetry, below), not enforced as a hard retrieval ceiling here.
  //
  // Complementary to, not redundant with, the recall floors above: Task
  // 1.4's per-axis recall gate already requires BOTH product-insert#c2 and
  // quality-file#c2 to be retrieved for the dedup axis (chunk-level), but
  // says nothing about which *source paths* they came from. This test adds
  // the explicit source-path/provenance-level assertion plus non-gating
  // near-duplicate telemetry.

  it("keeps both /data/product-insert.md and /data/quality-file.md retrievable for the shared cartridge-life passage", async () => {
    const embeddings = loadEmbeddings();
    const logicalIdByDbId = await seedCorpus(KB_EVAL_CORPUS, embeddings);

    const dedupQuery = GOLD_QUERIES.find((q) => q.id === "gq-dedup-1");
    if (!dedupQuery) {
      throw new Error("gq-dedup-1 not found in GOLD_QUERIES — dedup axis fixture drifted");
    }
    // Sanity: this is the gold query whose relevant set spans both near-dup
    // chunks. If this ever stops holding, the query below is scoring the
    // wrong axis.
    expect(dedupQuery.relevantChunkIds).toEqual(["product-insert#c2", "quality-file#c2"]);

    const deps = embedderFor(dedupQuery, embeddings);
    const results = await retrieve(ORG_ID, ["/data"], dedupQuery.query, deps, { k: 10 });

    const translated = results.map((r) => {
      const logicalId = logicalIdByDbId.get(r.chunkId);
      if (!logicalId) {
        throw new Error(`retrieve() returned unseeded chunk id ${r.chunkId}`);
      }
      return { chunkId: logicalId, sourcePath: r.sourcePath };
    });

    // (b) TELEMETRY — visibility only, not a gate. Logs how many distinct
    // source paths carry the shared passage in the top-10 band.
    const distinctPaths = nearDuplicateSourcePaths(translated, dedupQuery.relevantChunkIds);
    if (process.env.KB_EVAL_VERBOSE) {
      console.log(
        "KB eval dedup-axis telemetry: distinct source paths carrying the shared passage:",
        distinctPaths
      );
    }

    // (a) GATE — provenance/distinctness preserved. Both paths must appear
    // among the top-10 results: a regression that starts collapsing
    // cross-path near-duplicates would break allowed_paths access scoping,
    // so this is a real access-control guard, not a ranking-quality check.
    expect(
      distinctPaths,
      `expected retrieval to keep BOTH /data/product-insert.md and /data/quality-file.md ` +
        `independently retrievable for the shared cartridge-life passage (query "${dedupQuery.query}"), ` +
        `but only found source paths ${JSON.stringify(distinctPaths)} in the top-10. ` +
        `If retrieval started deduping cross-path near-duplicates, allowed_paths access-control ` +
        `scoping would silently break for whichever path lost the collapse.`
    ).toEqual(expect.arrayContaining(["/data/product-insert.md", "/data/quality-file.md"]));
  });
});

describe("freshness axis (#858) — archived material is excluded by default, opt-in only", () => {
  // The mechanism proof behind the freshness axis's perfect numeric scores:
  // the archived 2013 AFNOR cert competes with the current 2024 cert for the
  // same query. Default retrieval must never surface the expired one (the
  // exact dangerous answer the 2026-07-14 Noack live test produced), and the
  // explicit includeArchived opt-in must bring it back for "search the
  // archive too". Seeded via statusForPath, so a regression in the ingest
  // rule OR the retrieval filter turns this red.
  const CURRENT = "quality/afnor-certificate-2024#c1";
  const ARCHIVED = "quality/OLD/afnor-certificate-2013#c1";

  it("returns the current cert but not the archived one by default, and includes the archived one on opt-in", async () => {
    const embeddings = loadEmbeddings();
    const logicalIdByDbId = await seedCorpus(KB_EVAL_CORPUS, embeddings);

    const freshnessQuery = GOLD_QUERIES.find((q) => q.id === "gq-freshness-1");
    if (!freshnessQuery) {
      throw new Error("gq-freshness-1 not found in GOLD_QUERIES — freshness axis fixture drifted");
    }
    const deps = embedderFor(freshnessQuery, embeddings);

    const toLogical = (results: Awaited<ReturnType<typeof retrieve>>) =>
      results.map((r) => {
        const logicalId = logicalIdByDbId.get(r.chunkId);
        if (!logicalId) throw new Error(`retrieve() returned unseeded chunk id ${r.chunkId}`);
        return logicalId;
      });

    const byDefault = toLogical(
      await retrieve(ORG_ID, ["/data"], freshnessQuery.query, deps, { k: 10 })
    );
    expect(byDefault).toContain(CURRENT);
    expect(
      byDefault,
      "default retrieval must NOT surface the expired 2013 cert under OLD/ — citing it is the dangerous answer #858 exists to prevent"
    ).not.toContain(ARCHIVED);

    const withArchive = toLogical(
      await retrieve(ORG_ID, ["/data"], freshnessQuery.query, deps, {
        k: 10,
        includeArchived: true,
      })
    );
    expect(
      withArchive,
      "the includeArchived opt-in must make the archived cert retrievable again ('search the archive too')"
    ).toContain(ARCHIVED);
  });
});

describe("crowding axis (#858) — a compilation binder cannot dominate the fused result list", () => {
  // The mechanism proof behind the crowding axis's numeric scores: the
  // per-document cap means no single document (here the multi-section quality
  // binder) can occupy more than maxChunksPerDoc slots of the fused result,
  // so a clean single-topic datasheet is never crowded out. Asserted on real
  // embeddinggemma embeddings, complementing the deterministic hand-vectored
  // proof in retrieve.integration.test.ts.
  it("caps the binder at the requested two chunks per document while still recalling the datasheet", async () => {
    const embeddings = loadEmbeddings();
    const logicalIdByDbId = await seedCorpus(KB_EVAL_CORPUS, embeddings);

    const crowdingQuery = GOLD_QUERIES.find((q) => q.id === "gq-crowding-1");
    if (!crowdingQuery) {
      throw new Error("gq-crowding-1 not found in GOLD_QUERIES — crowding axis fixture drifted");
    }
    const deps = embedderFor(crowdingQuery, embeddings);

    // Small k so the cap actually bites (the binder has five chunks that could
    // otherwise fill the whole list), and an explicit cap of 2 so this proves
    // the mechanism on real embeddings regardless of the default's value — the
    // default is pinned separately by the single-document-depth test in
    // retrieve.integration.test.ts.
    const results = await retrieve(ORG_ID, ["/data"], crowdingQuery.query, deps, {
      k: 4,
      maxChunksPerDoc: 2,
    });

    const perDoc = new Map<string, number>();
    for (const r of results) perDoc.set(r.documentId, (perDoc.get(r.documentId) ?? 0) + 1);
    for (const [documentId, n] of perDoc) {
      expect(
        n,
        `document ${documentId} contributed ${n} chunks, above the requested cap of 2`
      ).toBeLessThanOrEqual(2);
    }

    const logicalIds = results.map((r) => {
      const logicalId = logicalIdByDbId.get(r.chunkId);
      if (!logicalId) throw new Error(`retrieve() returned unseeded chunk id ${r.chunkId}`);
      return logicalId;
    });
    expect(
      logicalIds,
      "the clean datasheet chunk must survive the binder's crowding in the capped top-k"
    ).toContain("petrifilm-datasheet#c2");
  });
});
