import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  // Not mkdtempSync: its suffix could spell an archive word, the very flake under
  // test. A UUID is hex, and every archive word needs a letter beyond a-f.
  parent = join(tmpdir(), `pinchy-kb-root-helper-${randomUUID()}`);
  mkdirSync(parent);
});

function countingMkdtemp(dir: (prefix: string) => string) {
  const calls: string[] = [];
  const mkdtemp = (prefix: string) => {
    calls.push(prefix);
    const next = dir(prefix);
    mkdirSync(next);
    return next;
  };
  return { calls, mkdtemp };
}

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
    const { calls, mkdtemp } = countingMkdtemp(() => draws.shift()!);

    const root = makeKbSourceRoot("pinchy-kb-test-", { parent, mkdtemp });

    expect(root).toBe(cleanDraw);
    expect(existsSync(archivedDraw)).toBe(false);
    expect(calls).toEqual([join(parent, "pinchy-kb-test-"), join(parent, "pinchy-kb-test-")]);
  });

  it("gives up after a bounded number of draws and leaves none of them behind", () => {
    let n = 0;
    const { calls, mkdtemp } = countingMkdtemp(() => join(parent, `pinchy-kb-test-${n++}old`));

    expect(() => makeKbSourceRoot("pinchy-kb-test-", { parent, mkdtemp })).toThrow(/20 draws/);
    expect(calls).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(existsSync(join(parent, `pinchy-kb-test-${i}old`))).toBe(false);
    }
  });

  it("refuses a parent that is itself archived, since no suffix can fix that", () => {
    const archivedParent = join(parent, "OLD");
    mkdirSync(archivedParent);

    const { calls, mkdtemp } = countingMkdtemp((prefix) => `${prefix}x1`);

    expect(() => makeKbSourceRoot("pinchy-kb-test-", { parent: archivedParent, mkdtemp })).toThrow(
      /parent .* holds an archive word/
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a prefix that is itself an archive word instead of looping", () => {
    const { calls, mkdtemp } = countingMkdtemp((prefix) => `${prefix}x1`);

    expect(() => makeKbSourceRoot("archive-", { parent, mkdtemp })).toThrow(
      /prefix "archive-" holds an archive word/
    );
    expect(calls).toHaveLength(0);
  });
});
