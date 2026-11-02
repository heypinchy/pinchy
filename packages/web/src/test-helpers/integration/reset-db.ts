// The integration suite's per-test database reset.
//
// Lives apart from setup.ts so it can be tested directly
// (src/__tests__/db/integration-db-reset.integration.test.ts): setup.ts is a
// vitest setupFile and cannot be imported without registering its hooks again.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

// Tables that hold user/test state. Schema-only objects (drizzle migrations
// table, postgres system catalogs) are left alone. Order is irrelevant: the
// reset deletes from all of them in ONE statement, so foreign keys are only
// checked once every table is already empty.
export const APPLICATION_TABLES = [
  "audit_log",
  "chat_session_errors",
  "uploaded_files",
  "agent_delivered_files",
  "usage_records",
  "cost_budgets",
  "agent_connection_permissions",
  "tool_approval",
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
  "apikey", // Better Auth @better-auth/api-key plugin table (#572).
  "account",
  "session",
  '"user"', // Quoted because `user` is a reserved word in Postgres.
  "settings",
  "models",
  "openai_compatible_providers",
  "audit_verify_state",
  "kb_documents",
  "kb_chunks",
  "kb_index_jobs",
] as const;

const quoted = (tables: readonly string[]) =>
  `ARRAY[${tables.map((t) => `'${t}'`).join(", ")}]::regclass[]`;

/** The one method of a drizzle client the ANN lookup needs. */
export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/**
 * Lookup of the tables carrying an approximate-nearest-neighbour index
 * (pgvector hnsw / ivfflat), memoised for the rest of the test file: the
 * schema does not change mid-run.
 *
 * Only a SUCCESS is memoised. A cached rejection would turn one transient DB
 * error into a failure of every later `beforeEach` in the file, all of them
 * blaming the reset rather than the blip.
 */
export function annTableLookup(client: SqlExecutor): () => Promise<string[]> {
  let cached: Promise<string[]> | undefined;
  return () => {
    cached ??= Promise.resolve(
      client.execute(
        sql.raw(`
        SELECT DISTINCT i.indrelid::regclass::text AS rel
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
        WHERE am.amname IN ('hnsw', 'ivfflat')
          AND i.indrelid = ANY (${quoted(APPLICATION_TABLES)})`)
      )
    )
      .then((rows) => (rows as { rel: string }[]).map((r) => r.rel))
      .catch((err: unknown) => {
        cached = undefined;
        throw err;
      });
    return cached;
  };
}

const findAnnTables = annTableLookup(db);

/**
 * Empty every application table and restart the sequences they own — what
 * `TRUNCATE ... RESTART IDENTITY CASCADE` did, without its side effect.
 *
 * TRUNCATE gives every table, index, TOAST table and sequence a NEW
 * relfilenode: ~210 new files per test, each an fsync owed at the next
 * checkpoint. `DROP DATABASE` forces an immediate checkpoint and waits for it,
 * so the migration tests that drop a throwaway database in `afterAll` paid for
 * every test since the last checkpoint — 45s under load, past the 30s hook
 * timeout, in whichever migration file happened to run next. DELETE on these
 * near-empty tables writes into the files that already exist, so the debt
 * stays bounded by the schema instead of growing with the suite. See
 * src/__tests__/db/integration-db-reset.integration.test.ts.
 *
 * Tables with an ANN index are the exception and are still TRUNCATEd: an HNSW
 * scan collects its ef_search candidates before checking visibility, so dead
 * tuples left by DELETE would crowd live rows out of a later test's
 * vector-search results. The test is whether the heap has STORAGE
 * (`pg_relation_size > 0`), not whether it has live rows: a test that deletes
 * every chunk itself (ingest's "removes the document and its chunks") leaves
 * no live row but every dead index entry, and an `EXISTS` check would wave
 * exactly that state through. A never-used table, or one this function already
 * truncated, has zero pages and costs nothing.
 *
 * What DELETE did NOT inherit from TRUNCATE by itself is the wait. TRUNCATE's
 * ACCESS EXCLUSIVE lock queued behind every open writer; a bare DELETE does
 * not, because a row from a transaction that has not committed yet is simply
 * invisible to its snapshot. An un-awaited background write from the previous
 * test then commits AFTER the reset and leaks into the next one. So the
 * transaction first takes `LOCK TABLE ... IN EXCLUSIVE MODE` on every table:
 * that conflicts with the ROW EXCLUSIVE lock every INSERT/UPDATE/DELETE holds,
 * so the reset waits for in-flight writers, and in READ COMMITTED the DELETE
 * that follows takes a fresh snapshot and sees what they committed. Plain
 * SELECTs (ACCESS SHARE) still pass, and a lock writes no file, so the
 * relfilenode debt above stays at zero. A test that leaves writers running
 * into the next test's reset can still deadlock against it, exactly as it
 * could against TRUNCATE; Postgres then aborts one side and says so.
 *
 * What this gives up: TRUNCATE handed every test brand-new, physically empty
 * heaps and fresh planner statistics. DELETE leaves dead tuples behind for
 * autovacuum to reclaim whenever it gets round to it, and the planner keeps
 * whatever statistics it last gathered. So a query WITHOUT `ORDER BY` no
 * longer reliably returns rows in insertion order across tests — new rows can
 * land in reclaimed space, and the plan can change. A flake of that shape
 * (right rows, wrong order, varying between runs) points at a missing
 * `ORDER BY` in the code or the assertion, not at this reset.
 */
export async function resetIntegrationDatabase(): Promise<void> {
  const ann = await findAnnTables();

  // One transaction: no other session ever sees audit_log's triggers disabled,
  // and a failure part-way leaves nothing half-reset.
  await db.transaction(async (tx) => {
    // Lock first, everything, each table in the strongest mode it will need,
    // strongest first. The ANN tables may be TRUNCATEd below, which needs
    // ACCESS EXCLUSIVE; taking it up front means no table is ever upgraded
    // from EXCLUSIVE inside this transaction. An upgrade is the classic
    // deadlock: a reader that slipped in under EXCLUSIVE holds the table the
    // upgrade waits for, then blocks on a table we already hold. The second
    // LOCK re-lists the ANN tables; a session never conflicts with its own
    // locks, so that costs nothing.
    if (ann.length > 0) {
      await tx.execute(sql.raw(`LOCK TABLE ${ann.join(", ")} IN ACCESS EXCLUSIVE MODE`));
    }
    await tx.execute(sql.raw(`LOCK TABLE ${APPLICATION_TABLES.join(", ")} IN EXCLUSIVE MODE`));

    // Checked under the lock, so a writer committing in between cannot give
    // an ANN table storage this reset then only DELETEs from.
    const annWithStorage = ann.length
      ? (
          (await tx.execute<{ rel: string }>(
            sql.raw(
              ann
                .map((t) => `SELECT '${t}' AS rel WHERE pg_relation_size('${t}') > 0`)
                .join(" UNION ALL ")
            )
          )) as unknown as { rel: string }[]
        ).map((r) => r.rel)
      : [];
    if (annWithStorage.length > 0) {
      await tx.execute(sql.raw(`TRUNCATE TABLE ${annWithStorage.join(", ")} CASCADE`));
    }
    // audit_log is immutable to production code (migration 0047's no_delete /
    // no_truncate triggers). Test isolation is the one legitimate exception,
    // so lift the trigger for this transaction instead of excluding audit_log
    // (which would leak rows between test files).
    await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_delete`);
    await tx.execute(
      sql.raw(
        `WITH ${APPLICATION_TABLES.map((t, i) => `d${i} AS (DELETE FROM ${t})`).join(", ")} SELECT 1`
      )
    );
    await tx.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_delete`);
    // RESTART IDENTITY's half: owned sequences back to their start value.
    // setval updates the sequence in place; ALTER SEQUENCE RESTART would mint
    // a new relfilenode, which is the debt this function exists to avoid.
    await tx.execute(
      sql.raw(`
        SELECT setval(s.seqrelid, s.seqstart, false)
        FROM pg_sequence s
        JOIN pg_depend d ON d.objid = s.seqrelid
          AND d.classid = 'pg_class'::regclass
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i')
        WHERE d.refobjid = ANY (${quoted(APPLICATION_TABLES)})`)
    );
  });
}
