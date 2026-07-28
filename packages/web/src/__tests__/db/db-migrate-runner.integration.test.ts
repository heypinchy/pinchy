/**
 * Behavioural guard for `pnpm db:migrate` against a real Postgres.
 *
 * Two things must hold, and the second is the one that was missing for as long
 * as `db:migrate` was `drizzle-kit migrate`:
 *
 *   1. A fresh database ends up fully migrated — the runner must keep drizzle's
 *      exact watermark semantics (one row per journal entry), because
 *      migration-090-upgrade-path and friends rest on them.
 *   2. A failing migration says WHAT failed and WHERE. drizzle-kit printed a
 *      spinner and exit code 1, nothing else: no statement, no PostgresError,
 *      not even the migration's name. entrypoint.sh runs the same command on
 *      every production upgrade, so that blank wall was also what an operator
 *      got when an upgrade aborted.
 *
 * The failure is provoked the way a real botched upgrade does it: the table
 * 0058 creates already exists. That also pins the ATTRIBUTION — the report has
 * to name 0058, not the first pending migration.
 *
 * Runs under `pnpm -C packages/web test:db` against the dev-stack Postgres on
 * :5434 (or VITEST_INTEGRATION_DB_URL). Uses its own throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// vitest runs with cwd = packages/web.
const WEB_ROOT = process.cwd();
const RUNNER = join(WEB_ROOT, "scripts", "db-migrate.mjs");
const MIGRATIONS_DIR = join(WEB_ROOT, "drizzle");

// Per-process DB names so concurrent runs can't collide on the throwaways.
const OK_DB = `pinchy_db_migrate_ok_${process.pid}`;
const FAIL_DB = `pinchy_db_migrate_fail_${process.pid}`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function runMigrate(databaseUrl: string) {
  const result = spawnSync(process.execPath, [RUNNER], {
    // Deliberately not packages/web: the runner must resolve its migrations
    // folder from its own location, not from whoever's cwd invoked it.
    cwd: WEB_ROOT === "/" ? WEB_ROOT : join(WEB_ROOT, ".."),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

async function appliedCount(url: string): Promise<number> {
  const client = postgres(url, { max: 1 });
  try {
    const [row] = await client<{ n: string }[]>`
      select count(*)::text as n from drizzle.__drizzle_migrations
    `;
    return Number(row.n);
  } finally {
    await client.end();
  }
}

describe("db:migrate runner", () => {
  const baseUrl =
    process.env.DATABASE_URL ??
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = withDbName(baseUrl, "postgres");
  let journalEntries = 0;

  beforeAll(async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8")
    ) as { entries: unknown[] };
    journalEntries = journal.entries.length;

    const admin = postgres(adminUrl, { max: 1 });
    try {
      for (const name of [OK_DB, FAIL_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE ${name}`);
      }
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      for (const name of [OK_DB, FAIL_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  });

  it("migrates a fresh database and records one row per journal entry", async () => {
    const url = withDbName(baseUrl, OK_DB);
    const run = runMigrate(url);

    expect(run.status, run.output).toBe(0);
    expect(await appliedCount(url)).toBe(journalEntries);
  });

  it("reports the migration, the statement and the PostgresError when one fails", async () => {
    const url = withDbName(baseUrl, FAIL_DB);

    // Squat on the table 0058_sudden_jubilee creates. Migrations 0000-0057
    // then apply and 0058 aborts — the shape of a real half-upgraded database.
    const client = postgres(url, { max: 1 });
    try {
      await client.unsafe(`CREATE TABLE "agent_delivered_files" ("id" text PRIMARY KEY)`);
    } finally {
      await client.end();
    }

    const run = runMigrate(url);

    expect(run.status, run.output).toBe(1);
    // The migration that actually threw, not the first pending one.
    expect(run.output).toContain("0058_sudden_jubilee");
    expect(run.output).not.toContain("0000_cold_young_avengers");
    // The statement.
    expect(run.output).toContain('CREATE TABLE "agent_delivered_files"');
    // The PostgresError, with the server's own code.
    expect(run.output).toContain('relation "agent_delivered_files" already exists');
    expect(run.output).toContain("42P07");

    // The report claims nothing was applied. Prove that claim is true rather
    // than merely reassuring: drizzle wraps all pending migrations in one
    // transaction, so the abort must have rolled every one of them back.
    expect(await appliedCount(url)).toBe(0);
  });
});
