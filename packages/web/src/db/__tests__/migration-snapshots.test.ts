import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DRIZZLE_DIR = join(__dirname, "../../../drizzle");
const META_DIR = join(DRIZZLE_DIR, "meta");

type JournalEntry = { idx: number; tag: string };
const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(join(META_DIR, "_journal.json"), "utf8")
);
const orderedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx);

function snapshotPath(idx: number) {
  return join(META_DIR, `${String(idx).padStart(4, "0")}_snapshot.json`);
}

function loadSnapshot(idx: number): { id: string; prevId: string } {
  return JSON.parse(readFileSync(snapshotPath(idx), "utf8"));
}

describe("drizzle snapshot chain", () => {
  it("every snapshot's prevId matches the previous snapshot's id", () => {
    let priorId: string | null = null;
    for (const entry of orderedEntries) {
      const snap = loadSnapshot(entry.idx);
      if (priorId !== null) {
        expect(
          snap.prevId,
          `snapshot ${entry.idx} (${entry.tag}) prevId should equal prior snapshot's id`
        ).toBe(priorId);
      }
      priorId = snap.id;
    }
  });

  it("all snapshot ids are unique", () => {
    const seen = new Map<string, JournalEntry>();
    for (const entry of orderedEntries) {
      const snap = loadSnapshot(entry.idx);
      const dup = seen.get(snap.id);
      expect(
        dup,
        `snapshot ${entry.idx} (${entry.tag}) reuses id ${snap.id} from ${dup?.idx} (${dup?.tag})`
      ).toBeUndefined();
      seen.set(snap.id, entry);
    }
  });

  it("every journal entry has a matching snapshot file", () => {
    const present = new Set(readdirSync(META_DIR).filter((f) => f.endsWith("_snapshot.json")));
    for (const entry of orderedEntries) {
      const expected = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      expect(
        present.has(expected),
        `journal references ${entry.tag} but ${expected} is missing`
      ).toBe(true);
    }
  });
});

describe("drizzle migration filenames", () => {
  // Known historical prefix collisions that already shipped to production and
  // cannot be renamed without breaking replay on existing databases. Drizzle
  // orders migrations by journal idx (not filename), so this is safe — but it
  // is also exactly the footgun that broke the snapshot chain in PR #341.
  // Do NOT add to this list without a strong reason; prefer renaming a new
  // migration locally before merge.
  const KNOWN_PREFIX_COLLISIONS = new Set(["0024"]);

  it("no two migrations share a numeric prefix", () => {
    const sqlFiles = readdirSync(DRIZZLE_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const byPrefix = new Map<string, string[]>();
    for (const file of sqlFiles) {
      const prefix = file.slice(0, 4);
      const bucket = byPrefix.get(prefix) ?? [];
      bucket.push(file);
      byPrefix.set(prefix, bucket);
    }
    const collisions = [...byPrefix.entries()]
      .filter(([prefix, files]) => files.length > 1 && !KNOWN_PREFIX_COLLISIONS.has(prefix))
      .map(([, files]) => files);
    expect(
      collisions,
      "new migration prefix collision detected — rename one of these files"
    ).toEqual([]);
  });
});
