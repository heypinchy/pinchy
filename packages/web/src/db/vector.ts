import { customType } from "drizzle-orm/pg-core";

import { EMBEDDING_DIMENSIONS } from "@/lib/knowledge/constants";

/**
 * Drizzle `vector(N)` column type backed by the pgvector extension
 * (`CREATE EXTENSION vector`). drizzle-orm has no built-in pgvector support, so
 * this is a hand-rolled `customType` mapping application-side `number[]`
 * embeddings to Postgres's `vector` wire format.
 *
 * The width is `EMBEDDING_DIMENSIONS` (768, embeddinggemma-300m), imported from
 * the knowledge constants so the column type and the embedder's expected width
 * have ONE source of truth and cannot drift. The live column is created by the
 * matching migration; changing the model's dimension is a destructive migration
 * (pgvector cannot alter a vector's width in place) plus a full re-embed.
 *
 * Usage: `embedding: vector("embedding")` in a `pgTable(...)` definition.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIMENSIONS})`;
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
