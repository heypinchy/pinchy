/**
 * Unit coverage for the `vector` customType (src/db/vector.ts). Fast,
 * DB-free complement to the pgvector.integration.test.ts round trip against
 * a real Postgres — this exercises toDriver/fromDriver directly.
 */
import { describe, it, expect } from "vitest";
import { pgTable, serial } from "drizzle-orm/pg-core";
import { vector } from "@/db/vector";

const probe = pgTable("vector_probe", {
  id: serial("id").primaryKey(),
  embedding: vector("embedding"),
});

describe("vector customType", () => {
  it("emits a vector(1024) SQL column type", () => {
    expect(probe.embedding.getSQLType()).toBe("vector(1024)");
  });

  it("serializes a number[] to the pgvector literal format on write", () => {
    expect(probe.embedding.mapToDriverValue([1, 0.5, -2])).toBe("[1,0.5,-2]");
  });

  it("parses Postgres's vector text output back to number[] on read", () => {
    expect(probe.embedding.mapFromDriverValue("[1,0.5,-2]")).toEqual([1, 0.5, -2]);
  });
});
