import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KB_EVAL_CORPUS } from "../../../../../eval/kb/corpus/manifest";
import { GOLD_QUERIES } from "../../../../../eval/kb/corpus/gold-queries";
import { GOLD_QA } from "../../../../../eval/kb/corpus/gold-qa";
import type { KbEvalAxis } from "../types";

const ALL_AXES: KbEvalAxis[] = [
  "happy",
  "path-citation",
  "dedup",
  "multi-hop",
  "distractor",
  "cross-lingual",
  "freshness",
  "crowding",
];

// Single source of truth for the manifest's chunk ids, reused by every
// referential-integrity assertion below.
const ALL_CHUNK_IDS = new Set(KB_EVAL_CORPUS.flatMap((d) => d.chunks.map((c) => c.id)));

describe("gold query set (Layer 1 retrieval)", () => {
  it("references only chunk ids that exist in the corpus manifest", () => {
    for (const q of GOLD_QUERIES) {
      for (const cid of q.relevantChunkIds) {
        expect(
          ALL_CHUNK_IDS.has(cid),
          `gold query ${q.id} references unknown chunk id ${cid}`
        ).toBe(true);
      }
    }
  });

  it("covers every axis with at least two queries and both languages overall", () => {
    for (const axis of ALL_AXES) {
      const count = GOLD_QUERIES.filter((q) => q.axis === axis).length;
      expect(count, `axis ${axis} has ${count} queries, expected >= 2`).toBeGreaterThanOrEqual(2);
    }
    const langs = new Set(GOLD_QUERIES.map((q) => q.lang));
    expect(langs.has("de"), 'no "de" query present in GOLD_QUERIES').toBe(true);
    expect(langs.has("en"), 'no "en" query present in GOLD_QUERIES').toBe(true);
  });

  it("gives every query at least one relevant chunk id (Layer 1 assumes a non-empty relevant set)", () => {
    for (const q of GOLD_QUERIES) {
      expect(
        q.relevantChunkIds.length,
        `gold query ${q.id} has an empty relevant set`
      ).toBeGreaterThan(0);
    }
  });
});

describe("gold Q/A set (Layer 3 groundedness)", () => {
  it("gives every non-abstention item a non-empty reference answer", () => {
    for (const qa of GOLD_QA) {
      if (!qa.expectAbstention) {
        expect(
          qa.referenceAnswer.length,
          `gold QA ${qa.id} has an empty referenceAnswer`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("references only chunk ids that exist in the corpus manifest", () => {
    for (const qa of GOLD_QA) {
      for (const cid of qa.relevantChunkIds) {
        expect(ALL_CHUNK_IDS.has(cid), `gold QA ${qa.id} references unknown chunk id ${cid}`).toBe(
          true
        );
      }
    }
  });

  it("has at least one abstention case with an empty relevant set", () => {
    const abstentionItems = GOLD_QA.filter((qa) => qa.expectAbstention === true);
    expect(abstentionItems.length).toBeGreaterThanOrEqual(1);
    for (const qa of abstentionItems) {
      expect(qa.relevantChunkIds).toEqual([]);
    }
  });
});

describe("GOLD_QUERIES <-> GOLD_QA paired-list drift guard", () => {
  it("keeps relevantChunkIds identical for any query string present in both arrays", () => {
    // GOLD_QA reuses GOLD_QUERIES question strings verbatim by design, but the
    // two arrays are authored independently (no runtime derivation). This guard
    // is the read-side sibling of the project's other paired-list guards: if a
    // shared query's relevant set diverges between the two files, fail loudly.
    // Comparison is order-sensitive (relevantChunkIds order is the ideal nDCG
    // rank, so a reorder is a real divergence worth flagging).
    const queryToChunks = new Map<string, string[]>();
    for (const q of GOLD_QUERIES) queryToChunks.set(q.query, q.relevantChunkIds);

    let comparedShared = 0;
    for (const qa of GOLD_QA) {
      const fromQueries = queryToChunks.get(qa.query);
      if (fromQueries === undefined) continue; // GOLD_QA-only question (e.g. abstention)
      comparedShared += 1;
      expect(
        qa.relevantChunkIds,
        `gold QA ${qa.id} relevantChunkIds diverge from the GOLD_QUERIES entry sharing its query string`
      ).toEqual(fromQueries);
    }

    // Guard against a vacuous pass: the arrays must actually share query strings.
    expect(
      comparedShared,
      "no shared query strings between GOLD_QUERIES and GOLD_QA"
    ).toBeGreaterThan(0);
  });
});

describe("corpus manifest chunk-text fixture guard", () => {
  it("has every chunk's text as a verbatim substring of its .md file body (all 34 chunks across 16 docs)", () => {
    const docsDir = resolve(__dirname, "../../../../../eval/kb/corpus/docs");
    let checkedChunks = 0;
    let checkedDocs = 0;
    for (const doc of KB_EVAL_CORPUS) {
      const body = readFileSync(resolve(docsDir, doc.file), "utf8");
      checkedDocs += 1;
      for (const chunk of doc.chunks) {
        checkedChunks += 1;
        expect(
          body.includes(chunk.text),
          `chunk ${chunk.id} text is not a verbatim substring of ${doc.file}`
        ).toBe(true);
      }
    }
    // Guard against a silently-empty manifest making this test a no-op pass.
    expect(checkedDocs).toBe(KB_EVAL_CORPUS.length);
    expect(checkedDocs).toBeGreaterThanOrEqual(16);
    expect(checkedChunks).toBeGreaterThanOrEqual(34);
  });
});
