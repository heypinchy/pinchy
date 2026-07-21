import { describe, expect, it } from "vitest";

import { isArchivedPath, statusForPath } from "@/lib/knowledge/archive-paths";

describe("isArchivedPath", () => {
  it.each([
    "/data/OLD/certificate-2013.pdf",
    "/data/quality/old/binder.pdf",
    "/data/Archive/2013/report.pdf",
    "/data/archived/report.pdf",
    "/data/Archiv/qualitaet/zertifikat.pdf",
    "/data/ARCHIVE/x.pdf",
  ])("flags %s (archive directory segment, case-insensitive)", (path) => {
    expect(isArchivedPath(path)).toBe(true);
  });

  it.each([
    // Segment-exact, not substring: real folder names containing the words.
    "/data/old-versions/report.pdf",
    "/data/Goldakte/report.pdf",
    "/data/archives-tools/manual.pdf",
    "/data/Bold/report.pdf",
    // The rule targets directories, never the file's own basename.
    "/data/archive.pdf",
    "/data/old.pdf",
    // Year/date folders are live structure, never archives.
    "/data/2013/certificate.pdf",
    "/data/Q3/report.pdf",
    // Plain current documents.
    "/data/quality/certificate-2024.pdf",
  ])("does not flag %s", (path) => {
    expect(isArchivedPath(path)).toBe(false);
  });
});

describe("statusForPath", () => {
  it("maps an archive path to 'archived'", () => {
    expect(statusForPath("/data/OLD/x.pdf")).toBe("archived");
  });

  it("maps a current path to 'active'", () => {
    expect(statusForPath("/data/x.pdf")).toBe("active");
  });
});
