/**
 * Behavior-layer guard for the v0.9.0 → v0.10 upgrade path.
 *
 * v0.9.0 was cut from the `release/0.9` branch, which carries a backport of
 * #905/#894 (the generic OpenAI-compatible provider). That feature needs the
 * `openai_compatible_providers` table, which on main is migration
 * 0059_right_speedball — sitting BEHIND three migrations that are not part of
 * 0.9.0: 0056 (KB embedder switch to 768-dim embeddinggemma), 0057 (KB archive
 * status backfill) and 0058 (agent_delivered_files).
 *
 * Drizzle's migrator is gated on a single high-water mark: pg-core's dialect
 * reads `select id, hash, created_at ... order by created_at desc limit 1` and
 * applies a migration only when its journal `when` exceeds that value. Shipping
 * the table as 0059 on the release branch would therefore park every 0.9.0
 * database's watermark at 0059's timestamp and skip 0056-0058 FOREVER — the KB
 * left on the old 1024-dim column that 0.10 expects to be 768-dim,
 * agent_delivered_files never created. That is the failure mode
 * 0035_smart_misty_knight shipped in v0.5.7 (see migration-upgrade-path and
 * migration-gap-repair) and migration-journal-order now prevents statically.
 *
 * The release branch avoids it by numbering its copy 0056_openai_compatible_
 * providers with a `when` BELOW main's 0056, keeping a 0.9.0 watermark under
 * every 0.10 migration. The cost lands here: such a database reaches
 * 0059_right_speedball with the table already present, so 0059 must be a
 * CREATE TABLE IF NOT EXISTS or the whole upgrade aborts on first boot.
 *
 * This test reproduces a released 0.9.0 database with the REAL migrator — never
 * hand-written DDL — and proves the upgrade to HEAD both succeeds and delivers
 * 0056-0058. It fails if someone regenerates 0059 without the guard.
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

// v0.9.0 branched after idx 55; 0056-0059 are the 0.10 additions.
const V090_LAST_IDX = 55;

// The release branch's own migration, mirrored here so this test reproduces a
// real 0.9.0 database instead of approximating one. The SQL is byte-identical
// to 0059_right_speedball's table definition (WITHOUT the IF NOT EXISTS guard —
// on a 0.9.0 database the table cannot pre-exist), and the timestamp is the one
// release/0.9 pins so its watermark stays below main's 0056.
const REL09_TAG = "0056_openai_compatible_providers";
const REL09_WHEN = 1784300000000;
const REL09_SQL = `CREATE TABLE "openai_compatible_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openai_compatible_providers_slug_unique" UNIQUE("slug")
);
`;

// Per-process DB name so concurrent runs can't collide on the throwaway DB.
const DB_NAME = `pinchy_090_upgrade_test_${process.pid}`;

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function readJournal(dir: string): Promise<{ entries: JournalEntry[] }> {
  return JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf-8")) as {
    entries: JournalEntry[];
  };
}

describe("migration upgrade path (v0.9.0 → HEAD)", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  const testUrl = withDbName(baseUrl, DB_NAME);
  let v090MigrationsDir: string;

  beforeAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // Build a "v0.9.0" migrations folder: every .sql file, the journal truncated
    // to idx <= 55, plus the release branch's own 0056 appended exactly as
    // release/0.9 ships it.
    v090MigrationsDir = await mkdtemp(join(tmpdir(), "pinchy-v090-"));
    await cp(REAL_MIGRATIONS, v090MigrationsDir, { recursive: true });
    const journal = await readJournal(v090MigrationsDir);
    journal.entries = journal.entries.filter((e) => e.idx <= V090_LAST_IDX);
    journal.entries.push({
      idx: V090_LAST_IDX + 1,
      version: "7",
      when: REL09_WHEN,
      tag: REL09_TAG,
      breakpoints: true,
    });
    await writeFile(
      join(v090MigrationsDir, "meta", "_journal.json"),
      JSON.stringify(journal, null, 2)
    );
    // main's 0056_serious_expediter.sql was copied along; the truncated journal
    // never references it, and the release tag gets its own file.
    await writeFile(join(v090MigrationsDir, `${REL09_TAG}.sql`), REL09_SQL);
  }, 120_000);

  afterAll(async () => {
    if (v090MigrationsDir) await rm(v090MigrationsDir, { recursive: true, force: true });
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("keeps the 0.9.0 watermark below every 0.10 migration", async () => {
    // The premise the whole upgrade rests on. If a future 0.10 migration were
    // ever backdated below REL09_WHEN it would be skipped on exactly this path,
    // and the behavioral assertions below would not necessarily catch it (they
    // only witness 0056 and 0058).
    const journal = await readJournal(REAL_MIGRATIONS);
    const laterThan090 = journal.entries.filter((e) => e.idx > V090_LAST_IDX);
    expect(laterThan090.length).toBeGreaterThan(0);
    for (const entry of laterThan090) {
      expect({ tag: entry.tag, above: entry.when > REL09_WHEN }).toEqual({
        tag: entry.tag,
        above: true,
      });
    }
  });

  it("upgrades a released 0.9.0 database to HEAD without losing 0056-0058", async () => {
    const relExists = async (client: postgres.Sql, rel: string): Promise<boolean> => {
      const [{ ok }] = await client`select to_regclass(${rel}) is not null as ok`;
      return ok as boolean;
    };

    // Phase 1 — reproduce a released 0.9.0 database with the real migrator.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: v090MigrationsDir });

        // It really is a 0.9.0 database: it HAS the backported provider table…
        expect(await relExists(client, "public.openai_compatible_providers")).toBe(true);
        // …and none of the 0.10 migrations, or the upgrade below proves nothing.
        expect(await relExists(client, "public.agent_delivered_files")).toBe(false);

        const [{ created_at: watermark }] = await client<{ created_at: string }[]>`
          select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
        expect(Number(watermark)).toBe(REL09_WHEN);
      } finally {
        await client.end();
      }
    }

    // Phase 2 — upgrade to HEAD. Without IF NOT EXISTS on 0059 this throws
    // 'relation "openai_compatible_providers" already exists' and a real
    // customer's container never finishes booting.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });
      } finally {
        await client.end();
      }
    }

    // Phase 3 — the three migrations the naive backport would have skipped.
    {
      const client = postgres(testUrl, { max: 1 });
      try {
        // 0058 — the clean binary signal.
        expect(await relExists(client, "public.agent_delivered_files")).toBe(true);
        // 0056 — the KB embedding column really was re-widened to 768 dims.
        const [{ dims }] = await client<{ dims: number | null }[]>`
          select atttypmod as dims from pg_attribute
          where attrelid = 'public.kb_chunks'::regclass and attname = 'embedding'`;
        expect(dims).toBe(768);
        // And the 0.9.0 table survived 0059 re-running as a no-op.
        expect(await relExists(client, "public.openai_compatible_providers")).toBe(true);
      } finally {
        await client.end();
      }
    }
  }, 180_000);
});
