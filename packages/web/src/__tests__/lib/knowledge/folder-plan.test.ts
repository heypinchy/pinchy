import { describe, expect, it } from "vitest";

import {
  buildFolderPlan,
  currentPlanFolder,
  deriveFolderState,
  folderKeyFor,
  folderPlanProgress,
  type FolderStateInput,
} from "@/lib/knowledge/folder-plan";

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
      ["/kb/a.pdf", "/kb/hr/1.pdf", "/kb/hr/x/2.pdf", "/kb/legal/3.pdf", "/kb/hr/4.pdf"]
    );
    expect(plan).toEqual([
      { folder: "/kb", files: 1 },
      { folder: "/kb/hr", files: 2 },
      { folder: "/kb/legal", files: 1 },
      { folder: "/kb/hr", files: 1 },
    ]);
  });

  it("drops a path no root contains", () => {
    expect(buildFolderPlan(["/kb"], ["/other/a.pdf"])).toEqual([]);
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
      pending: 0,
      current: false,
    });
  });

  it("counts a root as the sum of everything below it", () => {
    expect(folderPlanProgress(plan, "/kb", null).expected).toBe(6);
  });

  it("marks the folder holding the processed position as current", () => {
    expect(folderPlanProgress(plan, "/kb/legal", 3)).toEqual({
      expected: 2,
      pending: 2,
      current: true,
    });
    expect(folderPlanProgress(plan, "/kb/hr", 3)).toEqual({
      expected: 4,
      pending: 1,
      current: false,
    });
  });

  it("has nothing pending once the run is past the end", () => {
    expect(folderPlanProgress(plan, "/kb", 6)).toEqual({
      expected: 6,
      pending: 0,
      current: false,
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
    current: false,
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
});
