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

  // #1290: folder names from a real supplier share (~14k documents) that hold
  // superseded material. Each one is an archive word as a token of the name.
  it.each([
    "X_OLD",
    "X OLD",
    "xOLD",
    "Softwar_OLD",
    "OLD - don't use",
    "old inserts",
    "old sheets",
    "old files",
    "old documents",
    "old - FoodLab - Kits",
    "older versions",
    "Old versions",
    "Old certificates",
    "Old Test Kit Inserts",
    "Old MSDS",
    "Old Configurations",
    "OLD brochures",
    "OLD Presentations",
    "OLD Leaflets",
    "OLD INSTRUMENTS__update_files",
    "Expired",
    "Obsolete",
    "old-versions",
    "OLD2019",
    "Archives",
    "ARCHIVES",
    "Archiviert",
    "Alte Versionen",
    "alte Dokumente",
    "Ältere Versionen",
    "ÄLTERE VERSIONEN",
    "Veraltet",
  ])("flags a document under the folder %j", (folder) => {
    expect(isArchivedPath(`/data/Supplier/${folder}/certificate.pdf`)).toBe(true);
  });

  // Words that merely contain the letters of an archive word are live folders.
  it.each([
    "Gold",
    "GOLD",
    "AccuScan Gold",
    "AS-Gold - 1.7.11 Firmware",
    "Folder",
    "healthcare sector",
    "Malt Beta-Glucanase",
    "Gold Standard Diagnostics - EUS",
    "Goldakte",
    "Bold",
    "Archivübersicht",
    "Holder",
    "Oldtimer",
    // `alt` (German for "old") is deliberately not an archive word, see
    // archive-paths.ts.
    "Alt",
    "Logo alt",
    // `alter` is also German "age".
    "Alter",
    // A case change does not split a word (see archive-paths.ts).
    "OldVersions",
  ])("does not flag a document under the folder %j", (folder) => {
    expect(isArchivedPath(`/data/Supplier/${folder}/certificate.pdf`)).toBe(false);
  });

  it.each([
    // The rule targets directories, never the file's own basename.
    "/data/archive.pdf",
    "/data/old.pdf",
    "/data/Old certificate 2013.pdf",
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
