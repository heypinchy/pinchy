/**
 * Layer-3's groundedness premise lookup, against a real Postgres (#869 item 3).
 *
 * This has to be DB-backed, and that is the whole point: the defect it pins is
 * a *serialization* fault, invisible to any mock. `sql.array(paths)` sends a
 * parameter Postgres does not accept on the right side of `ANY`, so the query
 * throws `op ANY/ALL (array) requires array on right side` — every time, for
 * any non-empty input. Nothing about the TypeScript is wrong, which is why it
 * survived review and a full unit suite.
 *
 * It read as an intermittent bug ("on some runs") for a reason worth keeping in
 * mind when triaging the next one: `fetchChunkTexts` returns early on an empty
 * path list, and in that first sweep most answers cited nothing resolvable, so
 * most runs never reached the query at all. The runs that DID reach it were
 * exactly the ones with a well-formed Sources list — the answers the sweep
 * exists to grade. A defect that only fires on the good cases still looks rare.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";

import { fetchChunkTexts } from "../../../../eval/kb/chunk-texts";

const ORG_ID = "org-kb-eval-chunk-texts";
const PATH_A = "/data/eval/alpha.pdf";
const PATH_B = "/data/eval/beta.pdf";

const DB_URL = process.env.DATABASE_URL ?? "";

async function seed(sourcePath: string, texts: string[]) {
  const [doc] = await db
    .insert(kbDocuments)
    .values({ orgId: ORG_ID, sourcePath, contentHash: `hash-${sourcePath}`, status: "active" })
    .returning();

  for (const [i, chunkText] of texts.entries()) {
    await db.insert(kbChunks).values({
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath,
      chunkText,
      locator: { kind: "page", page: i + 1 },
    });
  }
}

describe("fetchChunkTexts", () => {
  // Seeding belongs in `beforeEach`, not `beforeAll`: the integration harness
  // TRUNCATEs every application table between tests (test-helpers/integration/
  // setup.ts), so a `beforeAll` seed is gone by the time the first test runs.
  beforeEach(async () => {
    await seed(PATH_A, ["Alpha first passage.", "Alpha second passage."]);
    await seed(PATH_B, ["Beta only passage."]);
  });

  it("returns every chunk text for the cited paths, keyed by path", async () => {
    const texts = await fetchChunkTexts(DB_URL, ORG_ID, [PATH_A, PATH_B]);

    expect(texts.get(PATH_A)).toEqual(
      expect.arrayContaining(["Alpha first passage.", "Alpha second passage."])
    );
    expect(texts.get(PATH_A)).toHaveLength(2);
    expect(texts.get(PATH_B)).toEqual(["Beta only passage."]);
  });

  it("handles a single cited path — the shape a minimal Sources list produces", async () => {
    const texts = await fetchChunkTexts(DB_URL, ORG_ID, [PATH_B]);

    expect(texts.get(PATH_B)).toEqual(["Beta only passage."]);
    expect(texts.has(PATH_A)).toBe(false);
  });

  it("scopes to the org, so another tenant's identical path cannot ground an answer", async () => {
    const [otherDoc] = await db
      .insert(kbDocuments)
      .values({
        orgId: "org-kb-eval-chunk-texts-other",
        sourcePath: PATH_A,
        contentHash: "hash-other",
        status: "active",
      })
      .returning();
    await db.insert(kbChunks).values({
      documentId: otherDoc.id,
      orgId: "org-kb-eval-chunk-texts-other",
      sourcePath: PATH_A,
      chunkText: "Another tenant's passage.",
      locator: { kind: "page", page: 1 },
    });

    const texts = await fetchChunkTexts(DB_URL, ORG_ID, [PATH_A]);

    expect(texts.get(PATH_A)).not.toContain("Another tenant's passage.");
    expect(texts.get(PATH_A)).toHaveLength(2);
  });

  it("returns an empty map without querying when nothing was cited", async () => {
    const texts = await fetchChunkTexts("postgres://invalid:1/nope", ORG_ID, []);

    expect(texts.size).toBe(0);
  });
});
