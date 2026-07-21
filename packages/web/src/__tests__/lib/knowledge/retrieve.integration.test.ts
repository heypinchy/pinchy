/**
 * Real-DB integration tests for retrieve() (hybrid pgvector + FTS retrieval,
 * fused via Reciprocal Rank Fusion). Uses a real PostgreSQL test database
 * (provisioned by global-setup.ts, truncated between tests by setup.ts).
 * kb_documents/kb_chunks rows are inserted DIRECTLY with hand-chosen
 * embeddinggemma-width embeddings and texts, so ranking is fully deterministic
 * without Ollama — the generated `tsv` column auto-populates from `chunk_text`
 * on insert. The embedder is dependency-injected: the fake below returns a
 * fixed vector for the query text so the test controls exactly how close/far it
 * is from each stored chunk's embedding.
 *
 * Vector setup: all vectors are EMBEDDING_DIMENSIONS-wide "one-hot" (or a 90/10 blend of two
 * one-hot) vectors. Two one-hot vectors along DIFFERENT axes are orthogonal,
 * so pgvector's cosine distance (`<=>`) between them is exactly 1 (maximally
 * far); identical one-hot vectors have cosine distance 0 (closest possible).
 * A 90/10 blend of axis 0 and axis 7 is very slightly off axis 0 (cosine
 * distance ~0.006), which deterministically ranks second-closest to a query
 * vector on axis 0 — closer than orthogonal, farther than identical.
 */
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { db } from "@/db";
import { kbChunks, kbDocuments } from "@/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/knowledge/constants";
import { retrieve, type RetrieveDeps } from "@/lib/knowledge/retrieve";

const ORG_ID = "org-kb-retrieve-test";
// Match the live column width so inserts don't fail the vector(N) check; a
// dimension change flows through here instead of a hardcoded literal.
const DIM = EMBEDDING_DIMENSIONS;

function oneHot(axis: number): number[] {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  return v;
}

function blend(axisA: number, weightA: number, axisB: number, weightB: number): number[] {
  const v = new Array(DIM).fill(0);
  v[axisA] = weightA;
  v[axisB] = weightB;
  return v;
}

/** Query embeds to axis 0 — matches the "best" chunk's embedding exactly. */
function fakeDeps(queryVector: number[] = oneHot(0)): {
  deps: RetrieveDeps;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => queryVector));
  return { deps: { embed }, embed };
}

interface SeedChunk {
  sourcePath: string;
  text: string;
  embedding: number[];
  page?: number;
  status?: "active" | "archived";
}

async function seedChunk(seed: SeedChunk): Promise<{ documentId: string; chunkId: string }> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: `hash-${seed.sourcePath}`,
      sourcePath: seed.sourcePath,
      status: seed.status ?? "active",
    })
    .returning();

  const [chunk] = await db
    .insert(kbChunks)
    .values({
      documentId: doc.id,
      orgId: ORG_ID,
      sourcePath: seed.sourcePath,
      chunkText: seed.text,
      page: seed.page ?? 1,
      embedding: seed.embedding,
    })
    .returning();

  return { documentId: doc.id, chunkId: chunk.id };
}

it("ranks the chunk matching both the embedding and the query terms on top", async () => {
  const best = await seedChunk({
    sourcePath: "/data/handbook.pdf",
    text: "The vacation policy allows unlimited PTO for senior staff.",
    embedding: oneHot(0),
  });
  const other = await seedChunk({
    sourcePath: "/data/cafeteria.pdf",
    text: "The cafeteria serves lunch from noon to two.",
    embedding: oneHot(50),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "vacation policy", deps);

  expect(results.length).toBeGreaterThan(0);
  expect(results[0]).toMatchObject({
    chunkId: best.chunkId,
    documentId: best.documentId,
    sourcePath: "/data/handbook.pdf",
    page: 1,
  });
  expect(typeof results[0].score).toBe("number");
  expect(results[0].score).toBeGreaterThan(0);
  // The irrelevant chunk may or may not surface (small corpus, no threshold
  // cutoff), but it must never outrank the doubly-relevant one.
  const otherResult = results.find((r) => r.chunkId === other.chunkId);
  if (otherResult) {
    expect(otherResult.score).toBeLessThan(results[0].score);
  }
});

it("respects the allowedPaths directory boundary without prefix bleed (/data/foo must not match /data/foobar)", async () => {
  const inside = await seedChunk({
    sourcePath: "/data/foo/manual.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });
  const outside = await seedChunk({
    sourcePath: "/data/foobar/other.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data/foo"], "vacation policy", deps);

  const ids = results.map((r) => r.chunkId);
  expect(ids).toContain(inside.chunkId);
  expect(ids).not.toContain(outside.chunkId);
});

it("matches an allowedPaths entry that is an exact file, without matching a sibling whose name is a superstring", async () => {
  const exact = await seedChunk({
    sourcePath: "/data/exact-file.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });
  const sibling = await seedChunk({
    sourcePath: "/data/exact-file.pdf-extra",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data/exact-file.pdf"], "vacation policy", deps);

  const ids = results.map((r) => r.chunkId);
  expect(ids).toContain(exact.chunkId);
  expect(ids).not.toContain(sibling.chunkId);
});

it("denies by default: an empty allowedPaths list returns no results and skips embedding", async () => {
  await seedChunk({
    sourcePath: "/data/handbook.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });

  const { deps, embed } = fakeDeps();
  const results = await retrieve(ORG_ID, [], "vacation policy", deps);

  expect(results).toEqual([]);
  expect(embed).not.toHaveBeenCalled();
});

it("excludes chunks belonging to archived documents", async () => {
  const archived = await seedChunk({
    sourcePath: "/data/archived.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
    status: "archived",
  });
  const active = await seedChunk({
    sourcePath: "/data/active.pdf",
    text: "Some unrelated onboarding notes.",
    embedding: oneHot(60),
    status: "active",
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "vacation policy", deps);

  const ids = results.map((r) => r.chunkId);
  expect(ids).not.toContain(archived.chunkId);
  expect(ids).toContain(active.chunkId);
});

it("fuses both retrieval arms via RRF: a chunk relevant in both arms outranks chunks relevant in only one, and both single-arm chunks still surface", async () => {
  // Matches the query both semantically (embedding == query embedding) and
  // lexically (contains "vacation" and "policy").
  const both = await seedChunk({
    sourcePath: "/data/both.pdf",
    text: "Full vacation policy text for all employees.",
    embedding: oneHot(0),
  });
  // Pure-vector match: embedding is the second-closest possible to the query
  // (90/10 blend, cosine distance ~0.006) but the text shares no query terms.
  const vectorOnly = await seedChunk({
    sourcePath: "/data/vector-only.pdf",
    text: "The printer on the third floor is out of toner.",
    embedding: blend(0, 0.9, 7, 0.1),
  });
  // Pure-FTS match: text matches strongly but the embedding is orthogonal
  // (cosine distance 1, maximally far) to the query embedding.
  const ftsOnly = await seedChunk({
    sourcePath: "/data/fts-only.pdf",
    text: "vacation policy vacation policy vacation policy",
    embedding: oneHot(99),
  });
  // Irrelevant in both arms: orthogonal embedding, no term overlap.
  const irrelevant = await seedChunk({
    sourcePath: "/data/irrelevant.pdf",
    text: "Parking permits renew annually in March.",
    embedding: oneHot(100),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "vacation policy", deps);

  const byId = new Map(results.map((r) => [r.chunkId, r]));
  expect(byId.has(both.chunkId)).toBe(true);
  expect(byId.has(vectorOnly.chunkId)).toBe(true);
  expect(byId.has(ftsOnly.chunkId)).toBe(true);

  const bothScore = byId.get(both.chunkId)!.score;
  const vectorOnlyScore = byId.get(vectorOnly.chunkId)!.score;
  const ftsOnlyScore = byId.get(ftsOnly.chunkId)!.score;

  // Relevant in both arms beats relevant in only one arm.
  expect(bothScore).toBeGreaterThan(vectorOnlyScore);
  expect(bothScore).toBeGreaterThan(ftsOnlyScore);

  // The chunk with zero relevance in either arm never outranks a chunk with
  // relevance in at least one arm.
  const irrelevantResult = byId.get(irrelevant.chunkId);
  if (irrelevantResult) {
    expect(irrelevantResult.score).toBeLessThan(vectorOnlyScore);
    expect(irrelevantResult.score).toBeLessThan(ftsOnlyScore);
  }
});

it("only retrieves chunks for the given org (ignores another org's data even under the same path)", async () => {
  const mine = await seedChunk({
    sourcePath: "/data/shared-name.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
  });

  // Seed a same-path document for a different org directly (bypassing the
  // ORG_ID-scoped seedChunk helper).
  const [otherDoc] = await db
    .insert(kbDocuments)
    .values({
      orgId: "org-kb-retrieve-other",
      contentHash: "hash-other",
      sourcePath: "/data/shared-name.pdf",
      status: "active",
    })
    .returning();
  const [otherChunk] = await db
    .insert(kbChunks)
    .values({
      documentId: otherDoc.id,
      orgId: "org-kb-retrieve-other",
      sourcePath: "/data/shared-name.pdf",
      chunkText: "The vacation policy allows unlimited PTO.",
      page: 1,
      embedding: oneHot(0),
    })
    .returning();

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "vacation policy", deps);

  const ids = results.map((r) => r.chunkId);
  expect(ids).toContain(mine.chunkId);
  // otherChunk is a raw kbChunks row, so its primary key is `id` — `seedChunk`
  // (used for `mine` above) is what returns a `chunkId`. Reading `.chunkId`
  // here yielded undefined, and `not.toContain(undefined)` passes against a
  // list of strings no matter what retrieve() does: this org-isolation
  // assertion was vacuous until the test typecheck gate caught it.
  expect(ids).not.toContain(otherChunk.id);

  // Sanity: the row really exists for the other org (guards against a typo
  // making this test vacuously pass).
  const otherRows = await db
    .select()
    .from(kbChunks)
    .where(eq(kbChunks.orgId, "org-kb-retrieve-other"));
  expect(otherRows).toHaveLength(1);
});

it("includes archived chunks when includeArchived is set (the 'search the archive too' opt-in)", async () => {
  const archived = await seedChunk({
    sourcePath: "/data/OLD/expired-cert.pdf",
    text: "The vacation policy allows unlimited PTO.",
    embedding: oneHot(0),
    status: "archived",
  });

  const { deps } = fakeDeps();
  const withoutOptIn = await retrieve(ORG_ID, ["/data"], "vacation policy", deps);
  const withOptIn = await retrieve(ORG_ID, ["/data"], "vacation policy", deps, {
    includeArchived: true,
  });

  expect(withoutOptIn.map((r) => r.chunkId)).not.toContain(archived.chunkId);
  expect(withOptIn.map((r) => r.chunkId)).toContain(archived.chunkId);
});

// --- crowding control (#858): one dominant document must not occupy the ---
// --- whole result list                                                  ---

/** Seeds ONE document with several chunks — the compilation-binder shape. */
async function seedDoc(
  sourcePath: string,
  chunks: Array<{ text: string; embedding: number[] }>
): Promise<{ documentId: string; chunkIds: string[] }> {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: `hash-${sourcePath}`,
      sourcePath,
      status: "active",
    })
    .returning();

  const chunkIds: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const [row] = await db
      .insert(kbChunks)
      .values({
        documentId: doc.id,
        orgId: ORG_ID,
        sourcePath,
        chunkText: chunk.text,
        page: i + 1,
        embedding: chunk.embedding,
      })
      .returning();
    chunkIds.push(row.id);
  }
  return { documentId: doc.id, chunkIds };
}

it("caps a single document's chunks in the fused top-k so a binder cannot crowd out the clean datasheet", async () => {
  // Binder: three chunks, all slightly closer to the query than the datasheet
  // chunk (90/10 blends vs. an 80/20 blend). Without a per-document cap the
  // binder fills the entire k=3 result list; with an explicit cap of 2, the
  // datasheet must surface. maxChunksPerDoc is pinned explicitly (not left to
  // the default) so this proves the CAP MECHANISM regardless of what the
  // default happens to be — the default's own value is pinned separately by
  // the single-document-depth test below. No chunk shares terms with the
  // query, so ranking is pure vector distance — fully deterministic.
  const binder = await seedDoc("/data/quality-binder.pdf", [
    { text: "Binder page about warming periods.", embedding: blend(0, 0.9, 7, 0.1) },
    { text: "Binder page about storage conditions.", embedding: blend(0, 0.9, 8, 0.1) },
    { text: "Binder page about shelf life.", embedding: blend(0, 0.9, 9, 0.1) },
  ]);
  const datasheet = await seedChunk({
    sourcePath: "/data/petrifilm-datasheet.pdf",
    text: "Datasheet section on warming.",
    embedding: blend(0, 0.8, 10, 0.2),
  });

  const { deps } = fakeDeps();
  // No seeded text contains "incubation", so the FTS arm is empty and the
  // ranking is pure vector distance — the binder's three chunks are strictly
  // closer than the datasheet chunk, which is what makes this red without
  // the per-document cap.
  const results = await retrieve(ORG_ID, ["/data"], "incubation", deps, {
    k: 3,
    maxChunksPerDoc: 2,
  });

  const binderCount = results.filter((r) => r.documentId === binder.documentId).length;
  expect(binderCount).toBeLessThanOrEqual(2);
  expect(results.map((r) => r.chunkId)).toContain(datasheet.chunkId);
});

it("lets one document contribute up to the default cap of chunks — a multi-passage answer isn't truncated", async () => {
  // The other side of the crowding trade-off: capping too tightly silently
  // drops legitimate depth. An answer often lives in several passages of ONE
  // document (a policy whose answer spans multiple sections), and the default
  // cap must be generous enough not to truncate that. This document has FOUR
  // near-identical-distance chunks; the default cap of 3 must surface exactly
  // three — proving the default neither collapses single-document depth to 2
  // (the tighter value this test exists to rule out) nor lets one document run
  // away with all four slots. If the default drops to 2, this goes red.
  const policy = await seedDoc("/data/leave-policy.pdf", [
    { text: "Leave policy section one.", embedding: blend(0, 0.9, 6, 0.1) },
    { text: "Leave policy section two.", embedding: blend(0, 0.9, 7, 0.1) },
    { text: "Leave policy section three.", embedding: blend(0, 0.9, 8, 0.1) },
    { text: "Leave policy section four.", embedding: blend(0, 0.9, 9, 0.1) },
  ]);

  const { deps } = fakeDeps();
  // Default maxChunksPerDoc (no override), k large enough that the cap — not k
  // — is what bounds this single document's contribution.
  const results = await retrieve(ORG_ID, ["/data"], "leave policy", deps, { k: 8 });

  const policyCount = results.filter((r) => r.documentId === policy.documentId).length;
  expect(
    policyCount,
    "the default cap must let a single document contribute three passages, not truncate to two"
  ).toBe(3);
});

it("honors a maxChunksPerDoc override of 1 (one chunk per document in the result list)", async () => {
  await seedDoc("/data/quality-binder.pdf", [
    { text: "Binder page one.", embedding: blend(0, 0.9, 7, 0.1) },
    { text: "Binder page two.", embedding: blend(0, 0.9, 8, 0.1) },
  ]);
  const datasheetA = await seedChunk({
    sourcePath: "/data/datasheet-a.pdf",
    text: "Datasheet A.",
    embedding: blend(0, 0.8, 10, 0.2),
  });
  const datasheetB = await seedChunk({
    sourcePath: "/data/datasheet-b.pdf",
    text: "Datasheet B.",
    embedding: blend(0, 0.7, 11, 0.3),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "incubation", deps, {
    k: 3,
    maxChunksPerDoc: 1,
  });

  const docCounts = new Map<string, number>();
  for (const r of results) {
    docCounts.set(r.documentId, (docCounts.get(r.documentId) ?? 0) + 1);
  }
  for (const [documentId, n] of docCounts) {
    expect(n, `document ${documentId} exceeded maxChunksPerDoc=1`).toBe(1);
  }
  expect(results.map((r) => r.chunkId)).toEqual(
    expect.arrayContaining([datasheetA.chunkId, datasheetB.chunkId])
  );
});

it("keeps byte-identical documents at different paths independently cap-counted (per-path ACL duplicates are separate documents)", async () => {
  // The crowding cap partitions by document_id, and per-path duplicates are
  // distinct documents BY DESIGN (uq_kb_doc_org_path) — so a duplicate at a
  // second path must not be folded into the first document's budget.
  const copyA = await seedChunk({
    sourcePath: "/data/team-a/datasheet.pdf",
    text: "Shared datasheet text.",
    embedding: blend(0, 0.9, 7, 0.1),
  });
  const copyB = await seedChunk({
    sourcePath: "/data/team-b/datasheet.pdf",
    text: "Shared datasheet text.",
    embedding: blend(0, 0.9, 7, 0.1),
  });

  const { deps } = fakeDeps();
  const results = await retrieve(ORG_ID, ["/data"], "incubation", deps, {
    k: 3,
    maxChunksPerDoc: 1,
  });

  const ids = results.map((r) => r.chunkId);
  expect(ids).toContain(copyA.chunkId);
  expect(ids).toContain(copyB.chunkId);
});
