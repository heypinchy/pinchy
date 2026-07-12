/**
 * Verifies the knowledge-base schema (kb_documents + kb_chunks) against a
 * real integration Postgres. kb_documents is the per-org, idempotent
 * (org_id, content_hash) source-of-truth for ingested files; kb_chunks
 * denormalizes org_id/source_path onto each chunk so retrieval (Task 7) can
 * filter by allowed_paths without a join, and carries a vector(1024)
 * (bge-m3) embedding plus an FTS tsv column for hybrid search.
 */
import { afterAll, it, expect } from "vitest";
import { db } from "@/db";
import { kbDocuments, kbChunks } from "@/db/schema";
import { eq } from "drizzle-orm";

const ORG_ID = "org-kb-schema-test";

it("inserts a document + chunk and queries the chunk by orgId", async () => {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: "hash-1",
      sourcePath: "/data/handbook.pdf",
      pageCount: 3,
    })
    .returning();

  expect(doc.status).toBe("active");

  await db.insert(kbChunks).values({
    documentId: doc.id,
    orgId: ORG_ID,
    sourcePath: "/data/handbook.pdf",
    chunkText: "Onboarding starts on day one.",
    page: 1,
    embedding: Array(1024).fill(0.1),
  });

  const rows = await db.select().from(kbChunks).where(eq(kbChunks.orgId, ORG_ID));
  expect(rows).toHaveLength(1);
  expect(rows[0].chunkText).toBe("Onboarding starts on day one.");
  expect(rows[0].sourcePath).toBe("/data/handbook.pdf");
  expect(rows[0].embedding).toHaveLength(1024);
});

it("enforces the (org_id, content_hash) idempotency unique constraint", async () => {
  await db.insert(kbDocuments).values({
    orgId: ORG_ID,
    contentHash: "hash-dup",
    sourcePath: "/data/a.pdf",
  });

  await expect(
    db.insert(kbDocuments).values({
      orgId: ORG_ID,
      contentHash: "hash-dup",
      sourcePath: "/data/b.pdf",
    })
  ).rejects.toThrow();
});

it("cascades chunk deletion when the parent document is deleted", async () => {
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      orgId: ORG_ID,
      contentHash: "hash-cascade",
      sourcePath: "/data/cascade.pdf",
    })
    .returning();

  await db.insert(kbChunks).values({
    documentId: doc.id,
    orgId: ORG_ID,
    sourcePath: "/data/cascade.pdf",
    chunkText: "This chunk should disappear with its document.",
  });

  await db.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));

  const remaining = await db.select().from(kbChunks).where(eq(kbChunks.documentId, doc.id));
  expect(remaining).toHaveLength(0);
});

afterAll(async () => {
  await db.delete(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
});
