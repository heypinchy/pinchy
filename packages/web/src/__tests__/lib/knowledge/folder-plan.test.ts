import { describe, expect, it } from "vitest";

import {
  buildFolderPlan,
  currentPlanFolder,
  deriveFolderState,
  folderKeyFor,
  folderPlanProgress,
  type FolderStateInput,
} from "@/lib/knowledge/folder-plan";

const current = (paths: string[]) => paths.map((path) => ({ path, archived: false }));

describe("folderKeyFor", () => {
  it("keys a file inside a subfolder by root plus first segment", () => {
    expect(folderKeyFor(["/data/kb"], "/data/kb/certs/2024/a.pdf")).toBe("/data/kb/certs");
  });

  it("keys a file directly in the root by the root", () => {
    expect(folderKeyFor(["/data/kb"], "/data/kb/a.pdf")).toBe("/data/kb");
  });

  it("keys a file root by itself", () => {
    expect(folderKeyFor(["/data/kb/a.pdf"], "/data/kb/a.pdf")).toBe("/data/kb/a.pdf");
  });

  it("ignores a trailing slash on the root", () => {
    expect(folderKeyFor(["/data/kb/"], "/data/kb/hr/a.pdf")).toBe("/data/kb/hr");
  });

  // "/data/kb" must never claim "/data/kbx/…" — the same boundary rule as the SQL path filter.
  it("does not match a sibling that only shares a prefix", () => {
    expect(folderKeyFor(["/data/kb"], "/data/kbx/a.pdf")).toBeNull();
  });

  it("uses the deepest containing root when grants overlap", () => {
    expect(folderKeyFor(["/data", "/data/hr"], "/data/hr/policies/a.pdf")).toBe(
      "/data/hr/policies"
    );
  });
});

describe("buildFolderPlan", () => {
  it("collapses consecutive files of one folder and keeps queue order", () => {
    const plan = buildFolderPlan(
      ["/kb"],
      current(["/kb/a.pdf", "/kb/hr/1.pdf", "/kb/hr/x/2.pdf", "/kb/legal/3.pdf", "/kb/hr/4.pdf"])
    );
    expect(plan).toEqual([
      { folder: "/kb", files: 1 },
      { folder: "/kb/hr", files: 2 },
      { folder: "/kb/legal", files: 1 },
      { folder: "/kb/hr", files: 1 },
    ]);
  });

  it("drops a path no root contains", () => {
    expect(buildFolderPlan(["/kb"], current(["/other/a.pdf"]))).toEqual([]);
  });

  // #1405: a run reads archived files last, so a folder's archive is a segment
  // of its own at the end of the queue — and it has to stay recognisable as
  // archive there, or the folder reads as unfinished until the run ends.
  it("marks archived files as segments of their own", () => {
    const plan = buildFolderPlan(
      ["/kb"],
      [
        { path: "/kb/hr/1.pdf", archived: false },
        { path: "/kb/hr/OLD/2.pdf", archived: true },
        { path: "/kb/hr/OLD/3.pdf", archived: true },
      ]
    );
    expect(plan).toEqual([
      { folder: "/kb/hr", files: 1 },
      { folder: "/kb/hr", files: 2, archived: true },
    ]);
  });
});

describe("folderPlanProgress", () => {
  const plan = [
    { folder: "/kb/hr", files: 3 },
    { folder: "/kb/legal", files: 2 },
    { folder: "/kb/hr", files: 1 },
  ];

  it("sums every segment of a folder for the expected count", () => {
    expect(folderPlanProgress(plan, "/kb/hr", null)).toEqual({
      expected: 4,
      expectedArchived: 0,
      pending: 0,
      pendingArchived: 0,
      current: false,
      currentArchived: false,
    });
  });

  it("counts a root as the sum of everything below it", () => {
    expect(folderPlanProgress(plan, "/kb", null).expected).toBe(6);
  });

  it("marks the folder holding the processed position as current", () => {
    expect(folderPlanProgress(plan, "/kb/legal", 3)).toEqual({
      expected: 2,
      expectedArchived: 0,
      pending: 2,
      pendingArchived: 0,
      current: true,
      currentArchived: false,
    });
    expect(folderPlanProgress(plan, "/kb/hr", 3)).toEqual({
      expected: 4,
      expectedArchived: 0,
      pending: 1,
      pendingArchived: 0,
      current: false,
      currentArchived: false,
    });
  });

  it("has nothing pending once the run is past the end", () => {
    expect(folderPlanProgress(plan, "/kb", 6)).toEqual({
      expected: 6,
      expectedArchived: 0,
      pending: 0,
      pendingArchived: 0,
      current: false,
      currentArchived: false,
    });
  });

  it("counts the archived files still to come apart from the current ones", () => {
    const withArchive = [
      { folder: "/kb/hr", files: 3 },
      { folder: "/kb/legal", files: 2 },
      { folder: "/kb/hr", files: 4, archived: true as const },
    ];
    // In legal: hr's current files are done, its archive is still to come.
    expect(folderPlanProgress(withArchive, "/kb/hr", 4)).toEqual({
      expected: 7,
      expectedArchived: 4,
      pending: 4,
      pendingArchived: 4,
      current: false,
      currentArchived: false,
    });
    // In hr's archive, one archived file done.
    expect(folderPlanProgress(withArchive, "/kb/hr", 6)).toEqual({
      expected: 7,
      expectedArchived: 4,
      pending: 3,
      pendingArchived: 3,
      current: true,
      currentArchived: true,
    });
  });
});

describe("currentPlanFolder", () => {
  it("names the folder at the processed position, and null past the end", () => {
    const plan = [
      { folder: "/kb/a", files: 2 },
      { folder: "/kb/b", files: 1 },
    ];
    expect(currentPlanFolder(plan, 0)).toBe("/kb/a");
    expect(currentPlanFolder(plan, 2)).toBe("/kb/b");
    expect(currentPlanFolder(plan, 3)).toBeNull();
  });
});

describe("deriveFolderState", () => {
  const base: FolderStateInput = {
    indexed: 10,
    notSearchable: 0,
    expected: 10,
    pending: 0,
    pendingArchived: 0,
    expectedArchived: 0,
    current: false,
    currentArchived: false,
    rereadArchived: 0,
    awaitingDiscovery: false,
  };

  it("is indexing while the run is in the folder", () => {
    expect(deriveFolderState({ ...base, current: true, pending: 4 })).toBe("indexing");
  });

  it("is queued while files are still to come", () => {
    expect(deriveFolderState({ ...base, pending: 4 })).toBe("queued");
    expect(
      deriveFolderState({ ...base, indexed: 0, expected: null, awaitingDiscovery: true })
    ).toBe("queued");
  });

  it("is searchable when every expected file is in with text", () => {
    expect(deriveFolderState(base)).toBe("searchable");
  });

  it("has errors when a document holds no text", () => {
    expect(deriveFolderState({ ...base, notSearchable: 1 })).toBe("has_errors");
  });

  // The half-done folder this issue is about: 40 of 100 in the index must not read as complete.
  it("has errors when the finished run left files out of the index", () => {
    expect(deriveFolderState({ ...base, indexed: 40, expected: 100 })).toBe("has_errors");
  });

  it("is not indexed when nothing is known about it", () => {
    expect(deriveFolderState({ ...base, indexed: 0, expected: null })).toBe("not_indexed");
  });

  it("is empty when the run found nothing to index", () => {
    expect(deriveFolderState({ ...base, indexed: 0, expected: 0 })).toBe("empty");
  });

  it("is searchable without a plan when everything indexed has text", () => {
    expect(deriveFolderState({ ...base, expected: null })).toBe("searchable");
  });

  // #1405: a first index reads archives last. A folder whose current files are
  // all in must not read "Queued" for hours because its archive is still to come.
  describe("while only archived files are still to come", () => {
    const archiveLeft: FolderStateInput = {
      ...base,
      indexed: 677,
      expected: 1105,
      pending: 428,
      pendingArchived: 428,
      expectedArchived: 428,
    };

    it("is searchable when every current file is in with text", () => {
      expect(deriveFolderState(archiveLeft)).toBe("searchable");
    });

    it("stays searchable while the run reads the archive", () => {
      expect(deriveFolderState({ ...archiveLeft, current: true, currentArchived: true })).toBe(
        "searchable"
      );
    });

    it("needs attention when a current file did not make it in", () => {
      expect(deriveFolderState({ ...archiveLeft, indexed: 670 })).toBe("has_errors");
      expect(deriveFolderState({ ...archiveLeft, notSearchable: 1 })).toBe("has_errors");
    });

    // A reconversion run re-reads archived Office files last. Until it gets to
    // them they wait for conversion — not an error, the run is on its way.
    it("stays searchable while archived files it will re-read wait for conversion", () => {
      expect(deriveFolderState({ ...archiveLeft, notSearchable: 40, rereadArchived: 40 })).toBe(
        "searchable"
      );
    });

    it("needs attention when an archived file holds no text", () => {
      expect(deriveFolderState({ ...archiveLeft, notSearchable: 41, rereadArchived: 40 })).toBe(
        "has_errors"
      );
    });

    // Only as many as are still to come can be on their way. The rest were
    // already read and failed — under a parent, behind another folder's archive.
    it("needs attention when more archived files wait than are still to come", () => {
      expect(
        deriveFolderState({
          ...archiveLeft,
          indexed: 1100,
          pending: 5,
          pendingArchived: 5,
          notSearchable: 7,
          rereadArchived: 7,
        })
      ).toBe("has_errors");
      expect(
        deriveFolderState({
          ...archiveLeft,
          indexed: 1100,
          pending: 5,
          pendingArchived: 5,
          notSearchable: 5,
          rereadArchived: 5,
        })
      ).toBe("searchable");
    });

    it("is still queued while current files are to come as well", () => {
      expect(deriveFolderState({ ...archiveLeft, pending: 430 })).toBe("queued");
    });

    // A folder that is nothing but archive has nothing searchable yet.
    // Reaching the first archived file must not make an archive-only folder
    // look finished: it holds no current file to be searchable for.
    it("keeps indexing a folder of only archived files until the run is through it", () => {
      const midArchive: FolderStateInput = {
        ...base,
        indexed: 1,
        expected: 5,
        pending: 4,
        pendingArchived: 4,
        expectedArchived: 5,
        current: true,
        currentArchived: true,
      };
      expect(deriveFolderState(midArchive)).toBe("indexing");
      // A re-run finds the archive already in the index; still not done.
      expect(deriveFolderState({ ...midArchive, indexed: 5 })).toBe("indexing");
    });

    it("is queued, or indexing, when the folder holds only archived files", () => {
      const onlyArchive = {
        ...base,
        indexed: 0,
        expected: 5,
        pending: 5,
        pendingArchived: 5,
        expectedArchived: 5,
      };
      expect(deriveFolderState(onlyArchive)).toBe("queued");
      expect(deriveFolderState({ ...onlyArchive, current: true, currentArchived: true })).toBe(
        "indexing"
      );
    });
  });
});
