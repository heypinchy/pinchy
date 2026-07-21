// Per-worker setup file for the vitest integration suite.
//
// Runs before each test file is imported. Truncates every application table
// before each test so tests are isolated from one another. We deliberately
// truncate-around-each-test instead of running each test in a transaction
// rolled back on teardown: the production code we exercise (Better Auth's
// signUpEmail, drizzle's db.transaction(...)) opens its own transactions, so
// outer-transaction rollback would mask bugs and confuse error messages.

import { afterAll, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Tables that hold user/test state. Schema-only objects (drizzle migrations
// table, postgres system catalogs) are left alone. Order is irrelevant because
// we use TRUNCATE ... CASCADE.
const APPLICATION_TABLES = [
  "audit_log",
  "chat_session_errors",
  "uploaded_files",
  "agent_delivered_files",
  "usage_records",
  "agent_connection_permissions",
  "integration_connections",
  "email_workflows",
  "email_workflow_connections",
  "processed_emails",
  "email_connection_cursors",
  "notifications",
  "notification_recipients",
  "channel_links",
  "channel_messages",
  "agent_groups",
  "user_groups",
  "invite_groups",
  "invites",
  "agents",
  "groups",
  "verification",
  "account",
  "session",
  '"user"', // Quoted because `user` is a reserved word in Postgres.
  "settings",
  "models",
  "audit_verify_state",
  "kb_documents",
  "kb_chunks",
  "kb_index_jobs",
] as const;

// Drift guard: a new pgTable in db/schema.ts that isn't added to the truncate
// list above would silently leak rows between tests until a future assertion
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
      `Integration test truncate list is out of date. New tables in db/schema.ts not yet truncated between tests: ${missing.join(", ")}. ` +
        `Add them to APPLICATION_TABLES in src/test-helpers/integration/setup.ts.`
    );
  }
});

beforeEach(async () => {
  // audit_log carries a statement-level `no_truncate` trigger (migration 0047)
  // so production code can never bulk-wipe it. Test isolation is the one
  // legitimate exception to that rule, so disable/re-enable it around the
  // shared reset instead of excluding audit_log (which would leak rows
  // between test files).
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_truncate`);
  try {
    await db.execute(
      sql.raw(`TRUNCATE TABLE ${APPLICATION_TABLES.join(", ")} RESTART IDENTITY CASCADE`)
    );
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_truncate`);
  }
});

// Drizzle's postgres-js client keeps a connection pool open. Without an
// explicit close, vitest hangs at the end of the run waiting for handles.
afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});
