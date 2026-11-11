import { describe, expect, it } from "vitest";

import {
  isArchivedPath,
  isArchivedUnder,
  kbRelativePath,
  statusForPath,
} from "@/lib/knowledge/archive-paths";

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
    expect(statusForPath("/data/OLD/x.pdf", ["/data"])).toBe("archived");
  });

  it("maps a current path to 'active'", () => {
    expect(statusForPath("/data/x.pdf", ["/data"])).toBe("active");
  });
});

// #1420: the rule reads the path BELOW the knowledge-base folder, never the
// folders the share happens to be mounted under.
describe("isArchivedUnder", () => {
  it("does not archive a folder whose parent is called Archiv", () => {
    const root = "/data/Archiv/Projekte";
    expect(isArchivedUnder(`${root}/plan.pdf`, [root])).toBe(false);
    expect(isArchivedUnder(`${root}/2024/Angebote/angebot.pdf`, [root])).toBe(false);
  });

  it("still archives an archive folder inside such a root", () => {
    const root = "/data/Archiv/Projekte";
    expect(isArchivedUnder(`${root}/OLD/plan.pdf`, [root])).toBe(true);
  });

  it("does not archive the contents of a root that is itself called Archiv", () => {
    expect(isArchivedUnder("/data/Archiv/x.pdf", ["/data/Archiv"])).toBe(false);
    expect(isArchivedUnder("/data/Archiv/2013/Berichte/x.pdf", ["/data/Archiv"])).toBe(false);
  });

  it("does not archive a file directly in the root", () => {
    expect(isArchivedUnder("/data/old/x.pdf", ["/data/old"])).toBe(false);
  });

  it("reads a root with a trailing slash the same as without", () => {
    expect(isArchivedUnder("/data/Archiv/Projekte/plan.pdf", ["/data/Archiv/Projekte/"])).toBe(
      false
    );
    expect(isArchivedUnder("/data/Archiv/Projekte/OLD/plan.pdf", ["/data/Archiv/Projekte/"])).toBe(
      true
    );
  });

  it("never archives a single-file root", () => {
    expect(isArchivedUnder("/data/OLD/handbook.pdf", ["/data/OLD/handbook.pdf"])).toBe(false);
  });

  it("classifies against the innermost root, whatever order the roots come in", () => {
    // One agent searches the whole share, another only its archive folder.
    // The document's status is org-wide, so it must not depend on which
    // agent's run reaches it: the innermost folder decides.
    const roots = ["/data/share", "/data/share/Archiv"];
    expect(isArchivedUnder("/data/share/Archiv/x.pdf", roots)).toBe(false);
    expect(isArchivedUnder("/data/share/Archiv/x.pdf", [...roots].reverse())).toBe(false);
    expect(isArchivedUnder("/data/share/OLD/x.pdf", roots)).toBe(true);
  });

  it("does not take a sibling with a common prefix for a root", () => {
    // `/data/sh` is not a folder of `/data/share/OLD/x.pdf`.
    expect(() => isArchivedUnder("/data/share/OLD/x.pdf", ["/data/sh"])).toThrow(
      /not inside any knowledge-base folder/
    );
  });

  it("handles the file-system root as a root", () => {
    expect(isArchivedUnder("/OLD/x.pdf", ["/"])).toBe(true);
    expect(isArchivedUnder("/x.pdf", ["/"])).toBe(false);
  });
});

describe("kbRelativePath", () => {
  it("is the path below the innermost root", () => {
    expect(kbRelativePath("/data/a/b/c.pdf", ["/data", "/data/a"])).toBe("b/c.pdf");
  });

  it("is empty for a single-file root", () => {
    expect(kbRelativePath("/data/a.pdf", ["/data/a.pdf"])).toBe("");
  });
});
