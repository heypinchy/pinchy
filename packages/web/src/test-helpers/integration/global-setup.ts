// Vitest globalSetup for the integration test suite.
//
// Provisions a dedicated Postgres database, runs Drizzle migrations against
// it, and tears it down after the run. Tests connect to it via DATABASE_URL,
// which is set by vitest.integration.config.ts so every worker sees the same
// value before @/db is imported.
//
// The connection URL comes from `integrationDbUrl()` — the SAME resolver
// vitest.integration.config.ts uses, so the database this file drops, creates
// and migrates is always the one the tests then talk to. It used to have its own
// `localhost:5434` default, which in an allocated worktree meant provisioning
// one server and testing against another; see db-url.ts.
//
// Running `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db`
// is enough to run the suite locally. CI overrides
// VITEST_INTEGRATION_DB_URL to use its postgres service.

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { integrationDbUrl } from "./db-url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function deriveAdminUrl(testDbUrl: string): string {
  // Replace the /<dbname> path with /postgres so we can drop+create the test DB.
  const u = new URL(testDbUrl);
  u.pathname = "/postgres";
  return u.toString();
}

function dbNameFromUrl(testDbUrl: string): string {
  const u = new URL(testDbUrl);
  return u.pathname.replace(/^\//, "");
}

export default async function globalSetup() {
  const testDbUrl = integrationDbUrl();
  const adminUrl = process.env.VITEST_INTEGRATION_ADMIN_URL ?? deriveAdminUrl(testDbUrl);
  const dbName = dbNameFromUrl(testDbUrl);

  const postgres = (await import("postgres")).default;
  // `database "…" does not exist, skipping` is the expected first-run NOTICE;
  // postgres.js's default handler console.logs the whole notice object, which
  // opens every `pnpm test:db` with a JSON blob that reads like a failure.
  const onnotice = (notice: Record<string, string>) => {
    process.stderr.write(`[test:db] ${notice.severity}: ${notice.message}\n`);
  };
  const sql = postgres(adminUrl, { onnotice });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${dbName}`);
  } finally {
    await sql.end();
  }

  // Run Drizzle migrations against the freshly created test DB.
  // packages/web is three levels up from this file
  // (src/test-helpers/integration/).
  const packageRoot = path.resolve(__dirname, "../../..");
  execSync("pnpm db:migrate", {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: testDbUrl },
    stdio: "inherit",
  });

  // Teardown
  return async () => {
    const sql2 = postgres(adminUrl, { onnotice });
    try {
      await sql2.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await sql2.end();
    }
  };
}
