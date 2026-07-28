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
import { formatMigrationFailure } from "./lib/migration-failure.mjs";

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

/**
 * Read the migration files in journal order so a failing statement can be
 * attributed to the migration it came from. Only called on the failure path.
 */
async function readMigrationFiles() {
  const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf-8"));
  return Promise.all(
    journal.entries.map(async (entry) => ({
      tag: entry.tag,
      sql: await readFile(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8"),
    }))
  );
}

const client = postgres(databaseUrl, {
  max: 1,
  // The default handler console.logs the whole notice object. These are
  // routine during a migration ("identifier will be truncated", "already
  // exists, skipping") and used to bury the run in JSON blobs.
  onnotice: (notice) => err(`[db:migrate] ${notice.severity}: ${notice.message}`),
});

try {
  out(`[db:migrate] applying migrations from ${MIGRATIONS_DIR}`);
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  const [row] = await client`
    select count(*)::text as n, max(created_at)::text as watermark
    from drizzle.__drizzle_migrations
  `;
  out(`[db:migrate] up to date — ${row.n} migrations recorded, watermark ${row.watermark}`);
} catch (error) {
  const migrationFiles = await readMigrationFiles().catch(() => []);
  err(formatMigrationFailure({ error, migrationFiles }));
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
