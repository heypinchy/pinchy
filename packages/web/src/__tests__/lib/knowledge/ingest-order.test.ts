import { describe, expect, it } from "vitest";

import { orderForIngest } from "@/lib/knowledge/ingest-order";

const paths = (items: { absPath: string }[]) => items.map((item) => item.absPath);
const files = (...absPaths: string[]) => absPaths.map((absPath) => ({ absPath }));

describe("orderForIngest", () => {
  it("puts every archived file after every current one", () => {
    // Retrieval hides archived documents unless asked, so a first index that
    // reaches them last has the searchable part of the corpus complete first.
    const ordered = orderForIngest(
      files("/data/OLD/a.pdf", "/data/Current/b.pdf", "/data/Archiv/c.pdf", "/data/z.pdf")
    );

    expect(paths(ordered)).toEqual([
      "/data/Current/b.pdf",
      "/data/z.pdf",
      "/data/Archiv/c.pdf",
      "/data/OLD/a.pdf",
    ]);
  });

  it("keeps each folder's files together so whole folders finish one after another", () => {
    // readdir order is whatever the file system hands back; a per-folder
    // progress view needs a folder to be finished before the next one starts.
    const ordered = orderForIngest(
      files(
        "/data/Supplier B/x.pdf",
        "/data/Supplier A/sub/y.pdf",
        "/data/Supplier B/a.pdf",
        "/data/Supplier A/b.pdf",
        "/data/Supplier A-Z/c.pdf"
      )
    );

    expect(paths(ordered)).toEqual([
      "/data/Supplier A/b.pdf",
      "/data/Supplier A/sub/y.pdf",
      "/data/Supplier A-Z/c.pdf",
      "/data/Supplier B/a.pdf",
      "/data/Supplier B/x.pdf",
    ]);
  });

  it("orders archived files by folder too", () => {
    const ordered = orderForIngest(
      files("/data/b/OLD/2.pdf", "/data/a/OLD/9.pdf", "/data/b/OLD/1.pdf")
    );

    expect(paths(ordered)).toEqual(["/data/a/OLD/9.pdf", "/data/b/OLD/1.pdf", "/data/b/OLD/2.pdf"]);
  });

  it("keeps the rest of each entry and does not change the input", () => {
    const input = [
      { absPath: "/data/OLD/a.pdf", bytes: 1 },
      { absPath: "/data/a.pdf", bytes: 2 },
    ];

    const ordered = orderForIngest(input);

    expect(ordered).toEqual([
      { absPath: "/data/a.pdf", bytes: 2 },
      { absPath: "/data/OLD/a.pdf", bytes: 1 },
    ]);
    expect(paths(input)).toEqual(["/data/OLD/a.pdf", "/data/a.pdf"]);
  });
});
