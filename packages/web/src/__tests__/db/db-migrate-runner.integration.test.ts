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
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// vitest runs with cwd = packages/web.
const WEB_ROOT = process.cwd();
const RUNNER = join(WEB_ROOT, "scripts", "db-migrate.mjs");
const MIGRATIONS_DIR = join(WEB_ROOT, "drizzle");

// Per-process DB names so concurrent runs can't collide on the throwaways.
const OK_DB = `pinchy_db_migrate_ok_${process.pid}`;
const FAIL_DB = `pinchy_db_migrate_fail_${process.pid}`;

// The failing run connects as a role of its own, with a password nothing else
// in the output could contain by accident. Asserting "the password is not in
// the output" with the suite's own credentials proves nothing useful: the
// usual throwaway setup is `pinchy`/`pinchy`, and `pinchy` is a substring of
// FAIL_DB and of the worktree path, so the check failed on a runner that leaked
// nothing — and a check that is red for the wrong reason gets loosened, after
// which it would also stay green for a runner that DID leak. 32 hex chars of
// fresh randomness can only appear in the output if the runner printed it.
const PROBE_ROLE_PREFIX = "pinchy_db_migrate_probe_";
const PROBE_ROLE = `${PROBE_ROLE_PREFIX}${process.pid}`;
const PROBE_PASSWORD = randomBytes(16).toString("hex");
// Far beyond any run of this file, short enough that a stranded role is dead
// the same afternoon.
const PROBE_ROLE_LIFETIME_SECONDS = 60 * 60;

/**
 * Remove probe roles that earlier runs failed to drop, together with the
 * databases they own (a role cannot be dropped while it owns one).
 *
 * Stale means: past its VALID UNTIL, or with none at all (created before the
 * role carried one), AND no session connected as it. Expiry rather than mere
 * idleness, because a concurrent run's role is idle between its own tests —
 * sweeping on "no session" alone would pull a live run's role out from under
 * it. The prefix is LIKE-escaped: its `_` would otherwise match any character.
 */
/** Escapes LIKE's metacharacters (and the escape character itself) so `text` matches literally. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

async function sweepStaleProbeRoles(admin: postgres.Sql): Promise<void> {
  const stale = await admin<{ rolname: string; oid: number }[]>`
    SELECT r.rolname, r.oid::int AS oid
    FROM pg_roles r
    WHERE r.rolname LIKE ${escapeLike(PROBE_ROLE_PREFIX) + "%"}
      AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil < now())
      AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usename = r.rolname)
  `;
  for (const { rolname, oid } of stale) {
    const owned = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datdba = ${oid}
    `;
    for (const { datname } of owned) {
      await admin`DROP DATABASE IF EXISTS ${admin(datname)} WITH (FORCE)`;
    }
    await admin`DROP ROLE IF EXISTS ${admin(rolname)}`;
  }
}

/**
 * The SCRAM-SHA-256 verifier Postgres would store for `password` — the
 * `pg_authid.rolpassword` format (RFC 5802 / 7677): PBKDF2-SHA256 over a random
 * salt, then StoredKey = SHA256(HMAC(salted, "Client Key")) and
 * ServerKey = HMAC(salted, "Server Key"). CREATE ROLE stores a value already in
 * this format as-is, so the server never receives the password itself and
 * cannot log it: not as statement text, not as a bind parameter, not as the
 * CONTEXT of a failing EXECUTE. SASLprep is skipped, which is exact for the
 * ASCII hex passwords this file generates.
 */
function scramSha256Verifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

function runMigrate(databaseUrl: string) {
  const result = spawnSync(process.execPath, [RUNNER], {
    // Deliberately not packages/web: the runner must resolve its migrations
    // folder from its own location, not from whoever's cwd invoked it.
    cwd: join(WEB_ROOT, ".."),
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
      await sweepStaleProbeRoles(admin);
      for (const name of [OK_DB, FAIL_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.unsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
      // SUPERUSER because migration 0054 runs `CREATE EXTENSION vector`, which
      // pgvector does not mark trusted. All it adds over the suite's own user is
      // a password that cannot collide with anything. A login superuser must not
      // outlive the run, though, and afterAll is not guaranteed to run (a hook
      // timeout, a killed process): VALID UNTIL makes a leftover unable to log
      // in after the hour, and the sweep above removes it on the next run.
      //
      // The expiry is computed by the server, whose clock is the one that
      // checks it: a host clock running an hour behind would otherwise create
      // a role that is already dead, and the sweep could pull it out from
      // under this very run. VALID UNTIL takes only a literal, hence the DO
      // block. The password goes in as its SCRAM verifier, never as itself:
      // with log_statement=all or log_min_duration_statement=0 the server logs
      // every statement's text AND its bind parameters, so the plaintext must
      // not reach it in any form (scramSha256Verifier). The role name and the
      // verifier are safe inside the dollar-quoted body: neither can contain a
      // quote or `$probe$`.
      const verifier = scramSha256Verifier(PROBE_PASSWORD);
      await admin.unsafe(`
        DO $probe$ BEGIN
          EXECUTE format(
            'CREATE ROLE %I LOGIN SUPERUSER PASSWORD %L VALID UNTIL %L',
            '${PROBE_ROLE}',
            '${verifier}',
            now() + make_interval(secs => ${PROBE_ROLE_LIFETIME_SECONDS})
          );
        END $probe$`);
      await admin.unsafe(`CREATE DATABASE ${OK_DB}`);
      await admin.unsafe(`CREATE DATABASE ${FAIL_DB} OWNER ${PROBE_ROLE}`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    // Each drop in its own attempt: a database that will not go (a slow
    // checkpoint, a lingering session) must not also strand the login role.
    // The errors are still thrown afterwards, so a broken teardown stays red.
    const admin = postgres(adminUrl, { max: 1 });
    const errors: unknown[] = [];
    const attempt = async (statement: string) => {
      try {
        await admin.unsafe(statement);
      } catch (err) {
        errors.push(err);
      }
    };
    try {
      for (const name of [OK_DB, FAIL_DB]) {
        await attempt(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      // Fails while FAIL_DB still exists (the role owns it). The role then
      // expires on its own and the next run's sweep collects both.
      await attempt(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    } finally {
      await admin.end();
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `db:migrate runner teardown failed (${errors.length})`);
    }
  });

  it("migrates a fresh database and records one row per journal entry", async () => {
    const url = withDbName(baseUrl, OK_DB);
    const run = runMigrate(url);

    expect(run.status, run.output).toBe(0);
    expect(await appliedCount(url)).toBe(journalEntries);
  });

  it("reports the migration, the statement and the PostgresError when one fails", async () => {
    const url = withCredentials(withDbName(baseUrl, FAIL_DB), PROBE_ROLE, PROBE_PASSWORD);

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

    // WHICH database it reached — the clue that would have ended this bug's
    // investigation in a minute — but never the password that gets it there.
    // stderr from this runner lands in CI logs and container logs verbatim.
    expect(run.output).toContain(FAIL_DB);
    expect(new URL(url).password).toBe(PROBE_PASSWORD); // the run really used it
    expect(run.output).not.toContain(PROBE_PASSWORD);

    // The report claims nothing was applied. Prove that claim is true rather
    // than merely reassuring: drizzle wraps all pending migrations in one
    // transaction, so the abort must have rolled every one of them back.
    expect(await appliedCount(url)).toBe(0);
  });
});
