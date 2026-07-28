#!/usr/bin/env node
// `pnpm db:migrate` — apply pending Drizzle migrations, and say what happened.
//
// This replaces `drizzle-kit migrate`, which was silent on failure: its bundled
// `hanji.renderWithTask` does `catch (err) { terminal.reject(err); process.exit(1) }`,
// where `reject` only re-renders the spinner and the `exit` fires before
// drizzle-kit's own `console.error`. A failed migration therefore printed a
// spinner line and exit code 1 — no statement, no PostgresError, not even the
// migration's name. entrypoint.sh runs this command on every production
// upgrade under `set -e`, so that blank wall was an operator's view of an
// aborted upgrade, not just a local annoyance.
//
// The migrator itself is unchanged: drizzle-orm's `migrate()` is what
// drizzle-kit called too, with the same defaults (drizzle.__drizzle_migrations,
// every pending migration in one transaction). Only the reporting is ours.
// `db:generate` and `db:studio` stay on drizzle-kit.
//
// Plain .mjs on plain node, like scripts/resolve-db-password.mjs: entrypoint.sh
// runs it in the production image, where there is no tsx and no path aliases.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  formatMigrationFailure,
  describeTarget,
  pendingMigrations,
} from "./lib/migration-failure.mjs";

// Resolved from this file, not from cwd, so `pnpm -C`, the entrypoint's
// `cd /app/packages/web` and a test harness all read the same folder. Pinned
// to drizzle.config.ts's `out` by migration-failure-report.test.ts.
const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/", import.meta.url));

const out = (msg) => process.stdout.write(`${msg}\n`);
const err = (msg) => process.stderr.write(`${msg}\n`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  err("[db:migrate] DATABASE_URL is not set");
  process.exit(1);
}

// host:port/database, never the password — see describeTarget. Printed on both
// paths: which Postgres this actually reached is half the diagnosis when the
// URL comes from a compose file or a test config rather than from the reader.
const target = describeTarget(databaseUrl);

/**
 * The migrations that were still pending when this run started, in journal
 * order, so a failing statement can be attributed to the migration it came
 * from. Only called on the failure path.
 *
 * Narrowed by the watermark because migrations repeat statements verbatim
 * (`DROP VIEW "public"."active_agents";` lives in 0016, 0042 and 0045); the
 * already-applied ones cannot be the culprit and only add false candidates.
 */
async function readPendingMigrationFiles(watermark) {
  const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf-8"));
  return Promise.all(
    pendingMigrations(journal.entries, watermark).map(async (entry) => ({
      tag: entry.tag,
      sql: await readFile(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"),
    }))
  );
}

/**
 * The watermark as it stands AFTER the failure. Drizzle rolls the whole run
 * back, so this is the pre-run state: exactly the boundary that says which
 * migrations this run was trying to apply. Null when the table isn't there
 * yet (a fresh database) or the connection is gone — then nothing is narrowed.
 */
async function readWatermark(client) {
  try {
    const [row] = await client`
      select max(created_at)::text as watermark from drizzle.__drizzle_migrations
    `;
    return row?.watermark ?? null;
  } catch {
    return null;
  }
}

const client = postgres(databaseUrl, {
  max: 1,
  // The default handler console.logs the whole notice object. These are
  // routine during a migration ("identifier will be truncated", "already
  // exists, skipping") and used to bury the run in JSON blobs.
  onnotice: (notice) => err(`[db:migrate] ${notice.severity}: ${notice.message}`),
});

let migrated = false;
try {
  out(`[db:migrate] applying migrations from ${MIGRATIONS_DIR}${target ? ` to ${target}` : ""}`);
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    migrated = true;
  } catch (error) {
    const migrationFiles = await readPendingMigrationFiles(await readWatermark(client)).catch(
      () => []
    );
    err(formatMigrationFailure({ error, migrationFiles, target }));
    process.exitCode = 1;
  }

  // Deliberately NOT inside the catch above. This query is decoration; if it
  // fails after every migration landed, reporting "migration failed — nothing
  // was applied" would be the exact opposite of the truth, in the one script
  // whose entire purpose is to tell it. Say what happened and still exit 0.
  if (migrated) {
    try {
      const [row] = await client`
        select
          count(*)::text as n,
          to_char(
            to_timestamp(max(created_at) / 1000.0) at time zone 'UTC',
            'YYYY-MM-DD HH24:MI:SS'
          ) as watermark
        from drizzle.__drizzle_migrations
      `;
      out(
        `[db:migrate] up to date — ${row.n} migrations recorded, watermark ${row.watermark ?? "none"} UTC`
      );
    } catch (error) {
      err(`[db:migrate] migrations applied; the summary query failed: ${error.message}`);
    }
  }
} finally {
  await client.end({ timeout: 5 });
}
