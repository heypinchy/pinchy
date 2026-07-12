/**
 * Real-DB integration tests for retrieve() (hybrid pgvector + FTS retrieval,
 * fused via Reciprocal Rank Fusion). Uses a real PostgreSQL test database
 * (provisioned by global-setup.ts, truncated between tests by setup.ts).
 * kb_documents/kb_chunks rows are inserted DIRECTLY with hand-chosen 1024-dim
 * embeddings and texts, so ranking is fully deterministic without Ollama —
 * the generated `tsv` column auto-populates from `chunk_text` on insert. The
 * embedder is dependency-injected: the fake below returns a fixed vector for
 * the query text so the test controls exactly how close/far it is from each
 * stored chunk's embedding.
 *
 * Vector setup: all vectors are 1024-dim "one-hot" (or a 90/10 blend of two
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
import { retrieve, type RetrieveDeps } from "@/lib/knowledge/retrieve";

const ORG_ID = "org-kb-retrieve-test";
const DIM = 1024;

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
  expect(ids).not.toContain(otherChunk.chunkId);

  // Sanity: the row really exists for the other org (guards against a typo
  // making this test vacuously pass).
  const otherRows = await db
    .select()
    .from(kbChunks)
    .where(eq(kbChunks.orgId, "org-kb-retrieve-other"));
  expect(otherRows).toHaveLength(1);
});
