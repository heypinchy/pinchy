import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableColumns, type Table } from "drizzle-orm";

import { inBatches, MAX_BIND_PARAMETERS, rowsPerInsert } from "@/db/insert-batches";
import { kbChunks, kbUnsupportedFiles } from "@/db/schema";

describe("inBatches", () => {
  it("cuts rows into consecutive slices of at most the given size", () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("keeps a list that fits as one batch, and an empty list as none", () => {
    expect(inBatches([1, 2], 2)).toEqual([[1, 2]]);
    expect(inBatches([], 3)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a batch size of %s", (size) => {
    expect(() => inBatches([1], size)).toThrow(RangeError);
  });
});

describe("rowsPerInsert", () => {
  // postgres.js refuses a query once it carries 65,534 parameters
  // (`parameters.length >= 65534` in its connection.js) — 65,533 is the most
  // one statement may bind.
  it("stays under the driver's parameter limit", () => {
    expect(MAX_BIND_PARAMETERS).toBe(65_533);
  });

  // Measured, not assumed: a row that fills EVERY column binds the most a row
  // can. A new column then shrinks the batch on its own instead of pushing it
  // over the limit — which is what this test fails on if the derivation stops
  // following the table.
  it.each<[string, Table, () => Record<string, unknown>]>([
    [
      "kb_chunks",
      kbChunks,
      () => ({
        id: crypto.randomUUID(),
        documentId: "doc",
        orgId: "org",
        sourcePath: "/kb/a.pdf",
        chunkText: "text",
        locator: { kind: "page", page: 1 },
        lang: "en",
        embedding: [0.1, 0.2],
      }),
    ],
    [
      "kb_unsupported_files",
      kbUnsupportedFiles,
      () => ({ orgId: "org", sourcePath: "/kb/a.tif", fileType: ".tif", seenAt: new Date(0) }),
    ],
  ])("fits a full batch of %s rows into one statement", (_name, table, fullRow) => {
    const row = fullRow();
    expect(Object.keys(row).sort()).toEqual(Object.keys(getTableColumns(table)).sort());

    const size = rowsPerInsert(table);
    const db = drizzle.mock();
    const full = db
      .insert(table)
      .values(Array.from({ length: size }, fullRow) as never)
      .toSQL();
    expect(full.params.length).toBeLessThanOrEqual(MAX_BIND_PARAMETERS);

    // And not wastefully small: one more row would not fit.
    const over = db
      .insert(table)
      .values(Array.from({ length: size + 1 }, fullRow) as never)
      .toSQL();
    expect(over.params.length).toBeGreaterThan(MAX_BIND_PARAMETERS);
  });
});
