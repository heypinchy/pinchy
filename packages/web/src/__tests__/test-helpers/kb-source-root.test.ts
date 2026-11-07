import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isArchivedPath } from "@/lib/knowledge/archive-paths";
import { makeKbSourceRoot } from "@/test-helpers/kb-source-root";

// The archive rule reads every directory segment of a document's ABSOLUTE
// path, so a random mkdtemp suffix such as `a7old2` (token `old`) flagged a
// whole test root as archived and turned `archived: 0` red at random.

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "pinchy-kb-root-helper-"));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe("makeKbSourceRoot", () => {
  it("creates a fresh directory under the parent whose files are not archived", () => {
    const root = makeKbSourceRoot("pinchy-kb-test-", { parent });

    expect(existsSync(root)).toBe(true);
    expect(dirname(root)).toBe(parent);
    expect(basename(root).startsWith("pinchy-kb-test-")).toBe(true);
    expect(isArchivedPath(join(root, "doc.pdf"))).toBe(false);
  });

  it("draws again when the random suffix spells an archive word, and removes the bad draw", () => {
    const archivedDraw = join(parent, "pinchy-kb-test-a7old2");
    const cleanDraw = join(parent, "pinchy-kb-test-a7b9c2");
    const draws = [archivedDraw, cleanDraw];
    const fakeMkdtemp = () => {
      const next = draws.shift()!;
      mkdirSync(next);
      return next;
    };

    const root = makeKbSourceRoot("pinchy-kb-test-", { parent, mkdtemp: fakeMkdtemp });

    expect(root).toBe(cleanDraw);
    expect(existsSync(archivedDraw)).toBe(false);
  });

  it("refuses a parent that is itself archived, since no suffix can fix that", () => {
    const archivedParent = join(parent, "OLD");
    mkdirSync(archivedParent);

    expect(() => makeKbSourceRoot("pinchy-kb-test-", { parent: archivedParent })).toThrow(
      /archive/i
    );
  });

  it("refuses a prefix that is itself an archive word instead of looping", () => {
    expect(() => makeKbSourceRoot("archive-", { parent })).toThrow(/archive-/);
  });
});
