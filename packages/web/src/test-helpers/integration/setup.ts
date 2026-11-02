// Per-worker setup file for the vitest integration suite.
//
// Runs before each test file is imported. Empties every application table
// before each test so tests are isolated from one another (see reset-db.ts for
// why that is a DELETE and not a TRUNCATE). We deliberately
// reset-around-each-test instead of running each test in a transaction
// rolled back on teardown: the production code we exercise (Better Auth's
// signUpEmail, drizzle's db.transaction(...)) opens its own transactions, so
// outer-transaction rollback would mask bugs and confuse error messages.

import { afterAll, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APPLICATION_TABLES, resetIntegrationDatabase } from "./reset-db";

// Drift guard: a new pgTable in db/schema.ts that isn't added to
// APPLICATION_TABLES (reset-db.ts) would silently leak rows between tests until a future assertion
// happened to fail. Compare the live schema's tables to this list and refuse
// to run if anything is missing — cheap insurance, fails loud at suite start.
beforeAll(async () => {
  const rows = await db.execute<{ tablename: string }>(
    sql.raw(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'`
    )
  );
  const live = new Set((rows as unknown as { tablename: string }[]).map((r) => r.tablename));
  const tracked = new Set(APPLICATION_TABLES.map((t) => t.replace(/^"|"$/g, "")));
  const missing = [...live].filter((t) => !tracked.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Integration test reset list is out of date. New tables in db/schema.ts not yet reset between tests: ${missing.join(", ")}. ` +
        `Add them to APPLICATION_TABLES in src/test-helpers/integration/reset-db.ts.`
    );
  }
});

beforeEach(resetIntegrationDatabase);

// Drizzle's postgres-js client keeps a connection pool open. Without an
// explicit close, vitest hangs at the end of the run waiting for handles.
afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});
