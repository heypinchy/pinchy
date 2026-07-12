/**
 * Verifies the pgvector extension (migration 0049_enable_pgvector) is
 * actually installed and usable against the real integration Postgres —
 * not just that the migration file exists.
 *
 * Foundation for the knowledge-base RAG index: later work adds
 * kb_documents/kb_chunks tables with vector(1024) embedding columns (bge-m3)
 * and HNSW indexes. This test only proves the extension + `<=>` cosine
 * distance operator are available.
 */
import { it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";

it("stores and cosine-searches vectors", async () => {
  await db.execute(sql`CREATE TEMP TABLE v (id int, e vector(3))`);
  await db.execute(sql`INSERT INTO v VALUES (1,'[1,0,0]'),(2,'[0,1,0]')`);
  // drizzle-orm's postgres-js driver returns rows directly from execute(),
  // not wrapped in a `.rows` property (unlike the node-postgres driver) —
  // see the same pattern in src/test-helpers/integration/setup.ts.
  const r = await db.execute<{ id: number }>(
    sql`SELECT id FROM v ORDER BY e <=> '[0.9,0.1,0]' LIMIT 1`
  );
  expect(r[0].id).toBe(1);
});
