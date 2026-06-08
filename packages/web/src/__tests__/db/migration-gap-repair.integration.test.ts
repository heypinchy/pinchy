/**
 * Behavior-layer guard for HEALING a database that already skipped a migration.
 *
 * `migration-upgrade-path.integration.test.ts` proves a CLEAN v0.5.6 install
 * receives the v0.5.7 migrations. This test covers the harder case: a database
 * that already ran the *buggy* journal and skipped `0035_smart_misty_knight`
 * (uploaded_files) while still applying the later `0036_models_table`.
 *
 * Why correcting the 0035 timestamp (PR #468) is NOT enough to heal such a DB:
 * drizzle's migrator gates on `migration.when > max(created_at already applied)`,
 * reading that max ONCE (`pg-core/dialect.cjs`: `order by created_at desc limit
 * 1`). A gap-victim DB's max is 0036's `when` (1779412920000); the *corrected*
 * 0035 `when` (1779412860001) is still below it, so 0035 is skipped forever.
 * The only forward fix is a NEW migration whose `when` exceeds every applied
 * row — the idempotent repair migration this test guards.
 *
 * This was the exact state of the staging server (which tracks `:next` and ate
 * the buggy build): 36 of 37 migrations applied, `uploaded_files` absent, so
 * every file upload 500'd. No *released* version ever shipped the buggy 0035, so
 * no real user can reach this state via a released upgrade — but `:next`-trackers
 * can, and a forward repair migration heals them with a clean `drizzle-kit
 * migrate`, never a destructive DB reset.
 *
 * Strategy (all with the REAL migrator, no manual SQL surgery):
 *   Phase 1 — migrate to the v0.5.6 state (journal idx ≤ 33).
 *   Phase 2 — migrate with a faithful copy of the BUGGY journal (0035's original
 *             out-of-order `when`, no repair entry). The migrator skips 0035 and
 *             applies 0036 — reproducing the staging gap. Asserted, so the test
 *             can't false-pass without actually creating the gap.
 *   Phase 3 — upgrade to HEAD (the real journal, incl. the repair migration) and
 *             assert uploaded_files is finally present.
 *
 * Runs under `pnpm -C packages/web test:db` against the dev-stack Postgres on
 * :5434 (or VITEST_INTEGRATION_DB_URL). Uses its own throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vitest runs with cwd = packages/web; the real migrations live in ./drizzle.
const REAL_MIGRATIONS = join(process.cwd(), "drizzle");

// v0.5.6 shipped migrations through idx 33; 0034/0035/0036 are the v0.5.7 adds.
const V056_LAST_IDX = 33;

// The 0035 entry: idx, tag, and its ORIGINAL out-of-order timestamp (the value
// before PR #468 corrected it to 1779412860001). Replaying the journal with
// this value is what makes the real migrator skip 0035, exactly as it did in
// every buggy `:next` build that produced the staging gap.
const IDX_0035 = 35;
const TAG_0035 = "0035_smart_misty_knight";
const BAD_0035_WHEN = 1779219073816;
const IDX_0036 = 36; // the later migration whose application strands 0035.

// Per-process DB name so concurrent runs can't collide on the throwaway DB.
const DB_NAME = `pinchy_gap_repair_test_${process.pid}`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function relExists(client: postgres.Sql, rel: string): Promise<boolean> {
  const [{ ok }] = await client`select to_regclass(${rel}) is not null as ok`;
  return ok as boolean;
}

describe("migration gap repair (skipped 0035 → healed at HEAD)", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  const testUrl = withDbName(baseUrl, DB_NAME);

  let v056Dir: string;
  let buggyDir: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // (a) v0.5.6 migrations: real .sql files, journal truncated to idx ≤ 33.
    v056Dir = await mkdtemp(join(tmpdir(), "pinchy-gap-v056-"));
    await cp(REAL_MIGRATIONS, v056Dir, { recursive: true });
    await rewriteJournal(v056Dir, (entries) => entries.filter((e) => e.idx <= V056_LAST_IDX));

    // (b) BUGGY journal: real .sql files, journal up to idx 36 (no repair entry),
    //     with 0035 restored to its original out-of-order timestamp.
    buggyDir = await mkdtemp(join(tmpdir(), "pinchy-gap-buggy-"));
    await cp(REAL_MIGRATIONS, buggyDir, { recursive: true });
    await rewriteJournal(buggyDir, (entries) =>
      entries
        .filter((e) => e.idx <= IDX_0036)
        .map((e) => (e.idx === IDX_0035 && e.tag === TAG_0035 ? { ...e, when: BAD_0035_WHEN } : e))
    );
  });

  afterAll(async () => {
    if (v056Dir) await rm(v056Dir, { recursive: true, force: true });
    if (buggyDir) await rm(buggyDir, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("heals a database that skipped 0035 (uploaded_files) but applied 0036", async () => {
    // Phase 1 — fresh DB to the v0.5.6 state.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: v056Dir });
        expect(await relExists(client, "public.uploaded_files")).toBe(false);
      } finally {
        await client.end();
      }
    }

    // Phase 2 — replay the buggy journal: 0035 is skipped, 0036 is applied.
    // These assertions guarantee the test actually reproduces the gap rather
    // than silently passing on a healthy DB.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: buggyDir });
        expect(await relExists(client, "public.uploaded_files")).toBe(false); // 0035 skipped
        expect(await relExists(client, "public.models")).toBe(true); // 0036 applied past it
      } finally {
        await client.end();
      }
    }

    // Phase 3 — upgrade to HEAD with the real journal (incl. the repair
    // migration). The corrected 0035 alone can't help (still gated out by 0036),
    // so a green here proves the forward repair migration healed the gap.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });
        expect(await relExists(client, "public.uploaded_files")).toBe(true);
      } finally {
        await client.end();
      }
    }
  });
});

async function rewriteJournal(
  dir: string,
  transform: (entries: JournalEntry[]) => JournalEntry[]
): Promise<void> {
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  journal.entries = transform(journal.entries);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
}

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  version: string;
  breakpoints: boolean;
};
