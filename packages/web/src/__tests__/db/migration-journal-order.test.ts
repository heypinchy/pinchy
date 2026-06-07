/**
 * Guard for the Drizzle migration journal ordering.
 *
 * Drizzle's migrator is timestamp-gated: on a non-empty database it applies a
 * migration only when its `when` (from drizzle/meta/_journal.json) is greater
 * than the most-recently-applied migration's timestamp. If an entry's `when`
 * is out of order relative to its position, that migration is silently SKIPPED
 * on every upgrade whose starting point is past the dip — the table/columns it
 * creates never appear, and the failure surfaces far away (e.g. a 500 on first
 * use of the feature), not at migrate time.
 *
 * This is exactly how `0035_smart_misty_knight` (uploaded_files) shipped broken:
 * its `when` predated `0034`, so drizzle skipped it on every v0.5.6→v0.5.7
 * upgrade. This guard makes that class of bug impossible to merge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// vitest runs with cwd = packages/web (pnpm -C packages/web test).
type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(
  readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf-8")
) as { entries: JournalEntry[] };

describe("drizzle migration journal", () => {
  it("lists entries in strictly ascending idx order", () => {
    const idxs = journal.entries.map((e) => e.idx);
    const violations = idxs
      .map((idx, i) => ({ idx, prev: idxs[i - 1] }))
      .filter((p, i) => i > 0 && p.idx <= p.prev!);
    expect(violations).toEqual([]);
  });

  it("has strictly increasing 'when' timestamps in idx order", () => {
    // Each migration's timestamp must be greater than every prior migration's,
    // otherwise drizzle's timestamp-gated migrator skips it on upgrade.
    const violations: string[] = [];
    let runningMax = -Infinity;
    let runningMaxTag = "(start)";
    for (const e of journal.entries) {
      if (e.when <= runningMax) {
        violations.push(
          `${e.tag} (when=${e.when}) is not after the preceding max ${runningMaxTag} (when=${runningMax}) — it would be skipped on upgrade`
        );
      } else {
        runningMax = e.when;
        runningMaxTag = e.tag;
      }
    }
    expect(violations).toEqual([]);
  });
});
