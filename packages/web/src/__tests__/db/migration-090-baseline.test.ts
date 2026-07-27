/**
 * Static guards for the v0.9.0 → v0.10 upgrade path.
 *
 * The behavioral proof lives in migration-090-upgrade-path.integration.test.ts:
 * it rebuilds a released 0.9.0 database and upgrades it to HEAD. That test needs
 * a real Postgres, so it only runs under `pnpm test:db` — and its own beforeAll
 * creates a throwaway database, which means a DB-less run cannot even report on
 * the premises.
 *
 * Those premises are pure facts about files in this repo, so they are checked
 * here as well: in the Docker-free suite, where a regenerated 0059 or a
 * backdated new migration is caught the moment it is written. Same split as
 * migration-journal-order.test.ts (static) ↔ migration-upgrade-path (behavior).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_MIGRATION_TAG,
  PROVIDER_TABLE,
  REL09_SQL,
  REL09_WHEN,
  V090_LAST_IDX,
  V090_LAST_TAG,
} from "@/test-helpers/release-090";

// vitest runs with cwd = packages/web (pnpm -C packages/web test).
const MIGRATIONS_DIR = join(process.cwd(), "drizzle");

type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8")) as {
  entries: JournalEntry[];
};

const providerMigration = readFileSync(
  join(MIGRATIONS_DIR, `${PROVIDER_MIGRATION_TAG}.sql`),
  "utf-8"
);

/** The migration's SQL with its comment header removed (`-->` breakpoints kept). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^--(?!>)/.test(line))
    .join("\n")
    .trimStart();
}

describe("v0.9.0 upgrade baseline", () => {
  it("pins the v0.9.0 cut to the migration it actually shipped", () => {
    // V090_LAST_IDX is a bare number everywhere else; this is what gives it a
    // meaning that a reader (and a future renumbering) can check.
    const last = journal.entries.find((e) => e.idx === V090_LAST_IDX);
    expect(last?.tag).toBe(V090_LAST_TAG);
  });

  it("keeps every post-0.9.0 migration above the 0.9.0 watermark", () => {
    // The premise the whole upgrade rests on: a 0.9.0 database's drizzle
    // watermark sits at REL09_WHEN, and drizzle applies a migration only when
    // its `when` exceeds the watermark. A new migration backdated below
    // REL09_WHEN would be skipped forever on exactly this upgrade path — the
    // 0035_smart_misty_knight failure, one release later.
    const later = journal.entries.filter((e) => e.idx > V090_LAST_IDX);
    expect(later.length).toBeGreaterThan(0);
    const violations = later
      .filter((e) => e.when <= REL09_WHEN)
      .map(
        (e) =>
          `${e.tag} (when=${e.when}) is not after the v0.9.0 watermark ${REL09_WHEN} — it would be skipped on every v0.9.0 → v0.10 upgrade`
      );
    expect(violations).toEqual([]);
  });

  it(`creates ${PROVIDER_TABLE} idempotently in ${PROVIDER_MIGRATION_TAG}`, () => {
    // A 0.9.0 database reaches this migration with the table already present.
    // `db:generate` emits a plain CREATE TABLE, so a regeneration silently
    // re-arms the upgrade abort; the integration test catches it too, but only
    // where a Postgres is running.
    expect(providerMigration).toContain(`CREATE TABLE IF NOT EXISTS "${PROVIDER_TABLE}"`);
  });

  it("keeps the released 0.9.0 DDL identical to the migration under test", () => {
    // REL09_SQL is what release/0.9 ran and what the integration test replays.
    // If 0059 is ever edited, that reproduction stops describing reality — so
    // report the edit here rather than letting the replay follow it silently.
    expect(
      stripComments(providerMigration).replace(
        `CREATE TABLE IF NOT EXISTS "${PROVIDER_TABLE}"`,
        `CREATE TABLE "${PROVIDER_TABLE}"`
      )
    ).toBe(REL09_SQL);
  });
});
