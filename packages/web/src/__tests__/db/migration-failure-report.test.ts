/**
 * Static guards for the migration failure report.
 *
 * `db:migrate` used to be `drizzle-kit migrate`, whose bundled `hanji`
 * swallows the error outright:
 *
 *     catch (err) { terminal.reject(err); process.exit(1); }
 *
 * `terminal.reject` only re-renders the spinner view (whose "rejected" state
 * prints the same `applying migrations...` line), and `process.exit(1)` fires
 * before drizzle-kit's own `catch { console.error(e) }` can run. The result is
 * a boot that ends on a spinner and exit code 1 with nothing to diagnose — in
 * `pnpm test:db` locally AND in `entrypoint.sh`, which runs the same command
 * under `set -e` on every production upgrade.
 *
 * The behavioural proof (a real Postgres, a real aborted upgrade) lives in
 * db-migrate-runner.integration.test.ts. These are the Docker-free halves:
 * the report's shape, and the folder the runner reads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMigrationFailure } from "../../../scripts/lib/migration-failure.mjs";

const MIGRATION_FILES = [
  { tag: "0057_kb_archive_status_backfill", sql: 'UPDATE "kb_documents" SET "status" = 0;' },
  {
    tag: "0058_sudden_jubilee",
    sql: 'CREATE TABLE "agent_delivered_files" (\n\t"id" text PRIMARY KEY NOT NULL\n);',
  },
];

/** Shaped like a postgres.js PostgresError: `severity` is what discriminates it. */
const pgError = (over: Record<string, unknown> = {}) =>
  Object.assign(new Error('relation "agent_delivered_files" already exists'), {
    name: "PostgresError",
    severity: "ERROR",
    code: "42P07",
    ...over,
  });

/**
 * Shaped like drizzle-orm's DrizzleQueryError — the object the migrator
 * actually throws. It carries `.query` (the SQL it sent) and wraps the driver's
 * PostgresError as `.cause`; neither half is on the outer error.
 */
const drizzleError = (query: string, cause: Error) =>
  Object.assign(new Error(`Failed query: ${query}\nparams: `), { query, cause });

describe("formatMigrationFailure", () => {
  it("names the migration the failing statement came from", () => {
    const report = formatMigrationFailure({
      error: drizzleError(
        'CREATE TABLE "agent_delivered_files" (\n\t"id" text PRIMARY KEY NOT NULL\n);',
        pgError()
      ),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).toContain("0058_sudden_jubilee");
    // Not the first pending migration, the one that actually threw.
    expect(report).not.toContain("0057_kb_archive_status_backfill");
  });

  it("digs the statement and the PostgresError out of the drizzle wrapper", () => {
    // Regression: the first cut read "the last statement postgres.js sent" via
    // the driver's debug hook and matched `severity` on the outer error. Both
    // miss — the driver issues a `rollback` right after the failure (so the
    // report blamed `rollback`, attributed to no migration), and the
    // PostgresError sits one `.cause` deeper (so no Postgres field printed at
    // all). Only the wrapper's own `.query` and `.cause` are authoritative.
    const report = formatMigrationFailure({
      error: drizzleError(
        'CREATE TABLE "agent_delivered_files" (\n\t"id" text PRIMARY KEY NOT NULL\n);',
        pgError()
      ),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).not.toMatch(/\brollback\b/i);
    expect(report).toContain("PostgresError");
    expect(report).toContain("42P07");
    expect(report).toContain("0058_sudden_jubilee");
  });

  it("surfaces the statement and every PostgresError field the server sent", () => {
    const report = formatMigrationFailure({
      error: drizzleError(
        "CREATE EXTENSION IF NOT EXISTS vector",
        pgError({
          message: 'extension "vector" is not available',
          code: "0A000",
          detail: 'Could not open extension control file ".../vector.control": No such file.',
          hint: "The extension must first be installed on the system.",
          position: "1",
        })
      ),
      migrationFiles: [{ tag: "0054_safe_vision", sql: "CREATE EXTENSION IF NOT EXISTS vector;" }],
    });

    expect(report).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(report).toContain('extension "vector" is not available');
    expect(report).toContain("0A000");
    expect(report).toContain("Could not open extension control file");
    expect(report).toContain("The extension must first be installed");
    expect(report).toContain("0054_safe_vision");
  });

  it("omits fields the server did not send rather than printing empty ones", () => {
    const report = formatMigrationFailure({
      error: drizzleError('CREATE TABLE "agent_delivered_files" ();', pgError()),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).not.toMatch(/^\s*(detail|hint|position):/m);
  });

  it("states that nothing was applied, because the migrator uses one transaction", () => {
    const report = formatMigrationFailure({
      error: drizzleError("SELECT 1", pgError()),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).toMatch(/single transaction/i);
  });

  it("says the migration is unknown instead of guessing when nothing matches", () => {
    const report = formatMigrationFailure({
      error: drizzleError("CREATE TABLE something_not_in_any_migration ()", pgError()),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).toContain("CREATE TABLE something_not_in_any_migration ()");
    expect(report).toMatch(/unknown/i);
    expect(report).not.toContain("0058_sudden_jubilee");
  });

  it("reports a non-Postgres failure verbatim without inventing Postgres fields", () => {
    // The other way `db:migrate` fails: the DB is not reachable at all. There
    // is no statement and no severity, so the report must not pretend either.
    const report = formatMigrationFailure({
      error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5434"), {
        code: "ECONNREFUSED",
      }),
      migrationFiles: MIGRATION_FILES,
    });

    expect(report).toContain("connect ECONNREFUSED 127.0.0.1:5434");
    expect(report).not.toMatch(/^\s*severity:/m);
    expect(report).not.toContain("0058_sudden_jubilee");
  });
});

describe("db-migrate runner wiring", () => {
  const webRoot = join(__dirname, "..", "..", "..");

  it("reads the same migrations folder drizzle-kit generates into", () => {
    // `db:generate` is still drizzle-kit and writes to drizzle.config.ts's
    // `out`; `db:migrate` is our runner and resolves the folder relative to
    // its own file. If the two drift, the runner silently applies nothing —
    // the exact class of quiet failure this whole change exists to remove.
    const config = readFileSync(join(webRoot, "drizzle.config.ts"), "utf-8");
    const runner = readFileSync(join(webRoot, "scripts", "db-migrate.mjs"), "utf-8");

    expect(config).toMatch(/out:\s*"\.\/drizzle"/);
    expect(runner).toMatch(/new URL\("\.\.\/drizzle\/", import\.meta\.url\)/);
  });

  it("is what `pnpm db:migrate` runs, so entrypoint.sh gets the report too", () => {
    const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf-8"));
    expect(pkg.scripts["db:migrate"]).toBe("node scripts/db-migrate.mjs");
  });
});
