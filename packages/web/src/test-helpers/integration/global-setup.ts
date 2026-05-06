// Vitest globalSetup for the integration test suite.
//
// Provisions a dedicated Postgres database, runs Drizzle migrations against
// it, and tears it down after the run. Tests connect to it via DATABASE_URL,
// which is set by vitest.integration.config.ts so every worker sees the same
// value before @/db is imported.
//
// Connection details are taken from VITEST_INTEGRATION_DB_URL (the test DB URL)
// and a derived admin URL on the same host. By default we point at the dev
// stack's Postgres on localhost:5434 — running `docker compose -f
// docker-compose.yml -f docker-compose.dev.yml up -d db` is enough to run the
// suite locally. CI overrides the URLs to use its postgres service.

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const testDbUrl =
    process.env.VITEST_INTEGRATION_DB_URL ??
    "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";
  const adminUrl = process.env.VITEST_INTEGRATION_ADMIN_URL ?? deriveAdminUrl(testDbUrl);
  const dbName = dbNameFromUrl(testDbUrl);

  const postgres = (await import("postgres")).default;
  const sql = postgres(adminUrl);
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
    const sql2 = postgres(adminUrl);
    try {
      await sql2.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await sql2.end();
    }
  };
}
