import { describe, expect, it } from "vitest";
import { KB_EVAL_CORPUS } from "../../../../../eval/kb/corpus/manifest";
import { GOLD_QUERIES } from "../../../../../eval/kb/corpus/gold-queries";
import { loadEmbeddings } from "../../../../../eval/kb/embeddings-fixture";

// Single source of truth for the corpus's chunk ids and the gold set's query
// ids, reused by every referential-integrity assertion below — same pattern
// as gold-set.test.ts's ALL_CHUNK_IDS.
const ALL_CHUNK_IDS = new Set(KB_EVAL_CORPUS.flatMap((d) => d.chunks.map((c) => c.id)));
const ALL_QUERY_IDS = new Set(GOLD_QUERIES.map((q) => q.id));

describe("KB eval committed embeddings fixture (Task 0.4)", () => {
  // Every assertion below calls loadEmbeddings() uncaught. That is deliberate:
  // when corpus/embeddings.json is absent (fresh checkout, or CI before the
  // fixture is committed), loadEmbeddings() throws an actionable "run pnpm
  // kb-eval:reembed" error rather than an opaque ENOENT/JSON.parse stack, and
  // each of these tests surfaces THAT message — a clean, self-explaining
  // failure that tells you exactly how to generate the missing fixture.

  it("declares model 'embeddinggemma-300m' and dim 768", () => {
    const fixture = loadEmbeddings();
    expect(fixture.model, `expected model "embeddinggemma-300m", got "${fixture.model}"`).toBe(
      "embeddinggemma-300m"
    );
    expect(fixture.dim, `expected dim 768, got ${fixture.dim}`).toBe(768);
  });

  it("has exactly one 768-dim embedding per corpus chunk id (no missing, no orphan)", () => {
    const fixture = loadEmbeddings();
    const fixtureChunkIds = new Set(Object.keys(fixture.chunks));

    const missing = [...ALL_CHUNK_IDS].filter((id) => !fixtureChunkIds.has(id));
    expect(missing, `chunk ids missing from embeddings.json: ${missing.join(", ")}`).toEqual([]);

    const orphans = [...fixtureChunkIds].filter((id) => !ALL_CHUNK_IDS.has(id));
    expect(
      orphans,
      `embeddings.json has chunk ids not present in KB_EVAL_CORPUS: ${orphans.join(", ")}`
    ).toEqual([]);

    for (const id of ALL_CHUNK_IDS) {
      const vec = fixture.chunks[id];
      expect(
        vec?.length,
        `chunk "${id}" embedding has ${vec?.length ?? "undefined"} dims, expected 768`
      ).toBe(768);
    }
  });

  it("has exactly one 768-dim embedding per gold query id (no missing, no orphan)", () => {
    const fixture = loadEmbeddings();
    const fixtureQueryIds = new Set(Object.keys(fixture.queries));

    const missing = [...ALL_QUERY_IDS].filter((id) => !fixtureQueryIds.has(id));
    expect(missing, `gold query ids missing from embeddings.json: ${missing.join(", ")}`).toEqual(
      []
    );

    const orphans = [...fixtureQueryIds].filter((id) => !ALL_QUERY_IDS.has(id));
    expect(
      orphans,
      `embeddings.json has query ids not present in GOLD_QUERIES: ${orphans.join(", ")}`
    ).toEqual([]);

    for (const id of ALL_QUERY_IDS) {
      const vec = fixture.queries[id];
      expect(
        vec?.length,
        `gold query "${id}" embedding has ${vec?.length ?? "undefined"} dims, expected 768`
      ).toBe(768);
    }
  });
});
