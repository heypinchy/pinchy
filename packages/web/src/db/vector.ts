import { customType } from "drizzle-orm/pg-core";

/**
 * Drizzle `vector(1024)` column type backed by the pgvector extension
 * (`CREATE EXTENSION vector`, packages/web/drizzle/0049_enable_pgvector.sql).
 * drizzle-orm has no built-in pgvector support, so this is a hand-rolled
 * `customType` mapping application-side `number[]` embeddings to Postgres's
 * `vector` wire format.
 *
 * 1024 dimensions matches bge-m3, the embedding model planned for the
 * knowledge-base RAG index (kb_documents/kb_chunks, later tasks).
 *
 * Usage: `embedding: vector("embedding")` in a `pgTable(...)` definition.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    // pgvector accepts the same `[1,2,3]` textual literal that JSON.stringify
    // produces for a plain number array.
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    // postgres-js has no built-in parser for the `vector` OID, so it hands
    // back the raw Postgres text form, e.g. "[1,0.5,-2]" — valid JSON.
    return JSON.parse(value) as number[];
  },
});
