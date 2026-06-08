/**
 * Behavior-layer guard for the migration UPGRADE path.
 *
 * The static `migration-journal-order.test.ts` guard asserts the journal is
 * strictly monotonic. This integration test proves the consequence: that a
 * database which already applied an earlier prefix (a real v0.5.6 install)
 * actually receives the later migrations when upgraded to HEAD.
 *
 * It would have caught the v0.5.7 release blocker (PR #468): `0035` /
 * `uploaded_files` had a `when` earlier than `0034`, so drizzle's
 * timestamp-gated migrator silently skipped it on every v0.5.6→v0.5.7 upgrade.
 * A fresh-migrate test could not catch this (an empty DB applies every
 * migration regardless of timestamp) — only a non-empty upgrade reproduces it.
 *
 * Strategy: migrate a fresh DB to the v0.5.6 state using a journal truncated to
 * the migrations that shipped in v0.5.6 (idx ≤ 33), then run the real migrator
 * against the full journal — exactly what a user upgrading to v0.5.7 does.
 *
 * Runs under `pnpm -C packages/web test:db` against the dev-stack Postgres on
 * :5434 (or VITEST_INTEGRATION_DB_URL). Uses its own throwaway database so it
 * does not interfere with the shared integration DB.
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

// The v0.5.6 baseline — the oldest upgrade origin this test witnesses (not
// "latest minus N"). v0.5.6 shipped migrations through idx 33
// (0033_remove_implicit_filesystem_tools); 0034/0035/0036 are the v0.5.7
// additions whose application this test proves.
const V056_LAST_IDX = 33;

// Per-process DB name so two concurrent runs of this suite (e.g. on a shared
// Postgres) can't collide on the throwaway database.
const DB_NAME = `pinchy_upgrade_path_test_${process.pid}`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe("migration upgrade path (v0.5.6 → HEAD)", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  const testUrl = withDbName(baseUrl, DB_NAME);
  let v056MigrationsDir: string;

  beforeAll(async () => {
    // Fresh throwaway database.
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // Build a "v0.5.6" migrations folder: all .sql files, but the journal
    // truncated to the entries that shipped in v0.5.6 (idx ≤ 33).
    v056MigrationsDir = await mkdtemp(join(tmpdir(), "pinchy-v056-"));
    await cp(REAL_MIGRATIONS, v056MigrationsDir, { recursive: true });
    const journalPath = join(v056MigrationsDir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf-8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= V056_LAST_IDX);
    await writeFile(journalPath, JSON.stringify(journal, null, 2));
  });

  afterAll(async () => {
    if (v056MigrationsDir) await rm(v056MigrationsDir, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("applies the v0.5.7 migrations when upgrading a v0.5.6 database", async () => {
    const relExists = async (client: postgres.Sql, rel: string): Promise<boolean> => {
      const [{ ok }] = await client`select to_regclass(${rel}) is not null as ok`;
      return ok as boolean;
    };

    // Phase 1 — migrate a fresh DB to the v0.5.6 state (idx 0..33).
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: v056MigrationsDir });
        // Precondition: the v0.5.7 table must NOT exist yet, otherwise the
        // post-upgrade assertion below would be meaningless.
        expect(await relExists(client, "public.uploaded_files")).toBe(false);
      } finally {
        await client.end();
      }
    }

    // Phase 2 — upgrade to HEAD with the real (full) journal.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });
      } finally {
        await client.end();
      }
    }

    // The v0.5.7 additions must now be present — the skip this guards against
    // left `uploaded_files` missing while `models` (0036) was created.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        expect(await relExists(client, "public.uploaded_files")).toBe(true); // 0035
        expect(await relExists(client, "public.models")).toBe(true); // 0036
        // 0024_cuddly_vapor (agent_connection_permissions) was the OTHER
        // out-of-order journal entry fixed in #468. It sits in the idx<=33
        // prefix, so phase 1 (a fresh/empty DB) already applied it regardless of
        // timestamp — this asserts it survived the upgrade rather than guarding
        // its skip behaviorally. The static journal-order guard covers the 0024
        // dip for upgrades that originate before idx 24.
        expect(await relExists(client, "public.agent_connection_permissions")).toBe(true);
      } finally {
        await client.end();
      }
    }
  });
});
