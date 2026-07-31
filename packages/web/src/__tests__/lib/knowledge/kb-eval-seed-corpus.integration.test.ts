/**
 * The Layer-3 sweep's corpus seeding, against a real Postgres.
 *
 * The sweep's seeder was written from the schema as remembered, not as it is,
 * and nothing could tell: it is raw SQL in a Playwright spec, so no vitest
 * test could reach it, and the sweep it belongs to had never run. Both of the
 * defects it shipped with are schema-level, which is why this test has to talk
 * to a real database rather than a mock:
 *
 *   1. It INSERTed a `page` column. There is none — the locator is a jsonb
 *      union (page / slide / heading / sheet-range), which is what makes a
 *      citation checkable in the first place. Every sweep died 200ms in with
 *      `column "page" of relation "kb_chunks" does not exist`. Loud, at least.
 *   2. It hard-coded `status: 'active'`. That one is silent, and worse: the
 *      freshness axis (#858) exists to check that an `OLD/` copy stays out of
 *      default retrieval, so seeding the archived AFNOR certificate as active
 *      would have the sweep grade the exact opposite of what the axis asks —
 *      and report a number for it.
 *
 * The assertions below read back through the Drizzle schema on purpose. The
 * seeder writes raw SQL; reading with the typed schema is what turns a column
 * that drifts into a failing test instead of a sweep that dies (or, worse,
 * doesn't).
 */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { statusForPath } from "@/lib/knowledge/archive-paths";

import { seedSyntheticCorpus } from "../../../../eval/kb/seed-corpus";
import { fetchChunkTexts } from "../../../../eval/kb/chunk-texts";
import { KB_EVAL_CORPUS } from "../../../../eval/kb/corpus/manifest";

const DB_URL = process.env.DATABASE_URL ?? "";

const EXPECTED_CHUNKS = KB_EVAL_CORPUS.reduce((n, doc) => n + doc.chunks.length, 0);

describe("seedSyntheticCorpus", () => {
  // The integration harness TRUNCATEs every application table between tests,
  // so each case seeds its own corpus rather than sharing one from beforeAll.
  beforeEach(async () => {
    await seedSyntheticCorpus(DB_URL);
  });

  it("seeds every corpus document under the single-tenant org the search route hardcodes", async () => {
    const docs = await db.select().from(kbDocuments);

    expect(docs).toHaveLength(KB_EVAL_CORPUS.length);
    expect(docs.map((d) => d.sourcePath).sort()).toEqual(
      KB_EVAL_CORPUS.map((d) => d.sourcePath).sort()
    );
    expect(new Set(docs.map((d) => d.orgId))).toEqual(new Set([DEFAULT_ORG_ID]));
  });

  it("derives each document's status from the archive rule, not a hard-coded 'active'", async () => {
    const docs = await db.select().from(kbDocuments);

    for (const doc of docs) {
      expect(doc.status, `status for ${doc.sourcePath}`).toBe(statusForPath(doc.sourcePath));
    }

    // Discrimination: the corpus must actually contain an archived path, or
    // the loop above passes for a seeder that hard-codes 'active' after all.
    const archived = docs.filter((d) => d.status === "archived");
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((d) => d.sourcePath.includes("/OLD/"))).toBe(true);
  });

  it("stores every chunk's position as a jsonb locator", async () => {
    const chunks = await db.select().from(kbChunks);

    expect(chunks).toHaveLength(EXPECTED_CHUNKS);
    for (const chunk of chunks) {
      expect(chunk.locator, `locator for ${chunk.sourcePath}`).toEqual({
        kind: "page",
        page: expect.any(Number),
      });
    }
  });

  it("stores the committed embedding for every chunk, so retrieval needs no live embedder", async () => {
    const chunks = await db.select().from(kbChunks);

    for (const chunk of chunks) {
      expect(chunk.embedding, `embedding for ${chunk.sourcePath}`).not.toBeNull();
      expect(chunk.embedding).toHaveLength(768);
    }
  });

  it("is idempotent, so a resumed sweep does not duplicate the corpus", async () => {
    await seedSyntheticCorpus(DB_URL);

    const [docs, chunks] = await Promise.all([
      db.select().from(kbDocuments),
      db.select().from(kbChunks),
    ]);

    expect(docs).toHaveLength(KB_EVAL_CORPUS.length);
    expect(chunks).toHaveLength(EXPECTED_CHUNKS);
  });

  it("repairs a status an earlier aborted run left wrong", async () => {
    // Not hypothetical: the `page`-column crash killed the first sweep
    // mid-document, leaving one kb_documents row and no chunks. A seeder that
    // only inserts would leave that row's status untouched forever — and the
    // freshness axis reads exactly that column. Since the status is derived
    // from the path, re-deriving it is never destructive.
    const archivedPath = KB_EVAL_CORPUS.map((d) => d.sourcePath).find(
      (p) => statusForPath(p) === "archived"
    );
    if (!archivedPath) throw new Error("corpus has no archived path to test with");

    await db
      .update(kbDocuments)
      .set({ status: "active" })
      .where(eq(kbDocuments.sourcePath, archivedPath));

    await seedSyntheticCorpus(DB_URL);

    const [doc] = await db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.sourcePath, archivedPath));
    expect(doc.status).toBe("archived");
  });

  it("seeds text the groundedness premise lookup can actually find", async () => {
    // Seeding and `fetchChunkTexts` are the two halves of one claim: an answer
    // citing a path must resolve to the passages it was graded against. Both
    // were broken, so assert them together rather than each in isolation.
    const paths = KB_EVAL_CORPUS.map((d) => d.sourcePath);

    const texts = await fetchChunkTexts(DB_URL, DEFAULT_ORG_ID, paths);

    for (const doc of KB_EVAL_CORPUS) {
      expect(texts.get(doc.sourcePath), `passages for ${doc.sourcePath}`).toHaveLength(
        doc.chunks.length
      );
    }
  });
});
