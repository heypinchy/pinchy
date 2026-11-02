/**
 * The integration suite's per-test reset (src/test-helpers/integration/reset-db.ts)
 * must leave the database empty WITHOUT minting new relation files.
 *
 * Why the second half matters: every file Postgres creates is an fsync it owes
 * at the next checkpoint, and `DROP DATABASE` forces an immediate one and waits
 * for it. The migration tests each drop a throwaway database in `afterAll`, so
 * whichever of them ran next paid for every test since the last checkpoint.
 * A TRUNCATE-based reset gave ~35 tables, their indexes, TOAST tables and
 * sequences new relfilenodes on every test — ~210 files each time. Measured on
 * a throwaway pgvector/pg17: 150 resets left 31,960 pending fsyncs and the next
 * DROP DATABASE took 41s; in a full `test:db` run under load one took 45s, and
 * migration-upgrade-path's afterAll died with "Hook timed out in 30000ms". The
 * cost had nothing to do with the file that paid it, so the failure moved
 * between the migration files from run to run.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, emailWorkflows, kbChunks, kbDocuments, usageRecords, users } from "@/db/schema";
import { APPLICATION_TABLES, resetIntegrationDatabase } from "@/test-helpers/integration/reset-db";

const TRACKED = APPLICATION_TABLES.map((t) => t.replace(/^"|"$/g, ""));

/**
 * relfilenode of every relation that stores a tracked table's data: the heap,
 * its indexes, its TOAST table + TOAST index, and the sequences it owns.
 * Keyed by relation name so a failure names the relation that moved.
 */
async function relationFiles(): Promise<Record<string, string>> {
  const rows = await db.execute<{ rel: string; filenode: string }>(sql`
    WITH tracked AS (
      SELECT c.oid, c.reltoastrelid FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY(${sql.raw(`ARRAY[${TRACKED.map((t) => `'${t}'`).join(",")}]`)})
    ),
    rels AS (
      SELECT oid FROM tracked
      UNION SELECT reltoastrelid FROM tracked WHERE reltoastrelid <> 0
      UNION SELECT i.indexrelid FROM pg_index i
        WHERE i.indrelid IN (SELECT oid FROM tracked)
           OR i.indrelid IN (SELECT reltoastrelid FROM tracked)
      UNION SELECT d.objid FROM pg_depend d
        JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
        WHERE d.classid = 'pg_class'::regclass AND d.refobjid IN (SELECT oid FROM tracked)
    )
    SELECT c.oid::regclass::text AS rel, pg_relation_filenode(c.oid)::text AS filenode
    FROM pg_class c WHERE c.oid IN (SELECT oid FROM rels)
  `);
  return Object.fromEntries(
    (rows as unknown as { rel: string; filenode: string }[]).map((r) => [r.rel, r.filenode])
  );
}

/** Rows in several tables, linked by every FK action the schema uses. */
async function seedRows(): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ email: "reset@test.local", name: "Reset", role: "admin" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Reset",
      model: "anthropic/claude-sonnet-4-6",
      greetingMessage: "hi",
      ownerId: user.id, // ON DELETE CASCADE from "user"
    })
    .returning();
  await db.insert(emailWorkflows).values({
    agentId: agent.id, // ON DELETE CASCADE from agents
    createdBy: user.id, // ON DELETE SET NULL from "user"
    name: "Reset",
    filter: {},
    action: "reset",
  });
  await db.insert(usageRecords).values({
    userId: user.id,
    agentId: agent.id,
    agentName: agent.name,
    sessionKey: "reset",
    inputTokens: 1,
    outputTokens: 1,
  });
  // Raw insert: the row only has to exist, and the reset must clear it despite
  // the immutability triggers appendAuditLog's rows are protected by.
  await db.execute(sql`
    INSERT INTO audit_log (actor_type, actor_id, event_type, row_hmac)
    VALUES ('system', 'system', 'test.reset', 'x')`);
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: [string, number][] = [];
  for (const table of APPLICATION_TABLES) {
    const [{ n }] = (await db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${table}`)
    )) as unknown as { n: number }[];
    counts.push([table, n]);
  }
  return Object.fromEntries(counts);
}

describe("integration database reset", () => {
  it("empties every tracked table", async () => {
    await seedRows();

    await resetIntegrationDatabase();

    expect(await rowCounts()).toEqual(Object.fromEntries(APPLICATION_TABLES.map((t) => [t, 0])));
  });

  it("restarts the sequences the tables own, as TRUNCATE ... RESTART IDENTITY did", async () => {
    await seedRows(); // advances both sequences: last_value 1, is_called true

    await resetIntegrationDatabase();

    const rows = (await db.execute<{ seq: string; last_value: string; is_called: boolean }>(sql`
      SELECT 'audit_log_id_seq' AS seq, last_value::text, is_called FROM audit_log_id_seq
      UNION ALL
      SELECT 'usage_records_id_seq', last_value::text, is_called FROM usage_records_id_seq
    `)) as unknown as { seq: string; last_value: string; is_called: boolean }[];
    expect(rows).toEqual([
      { seq: "audit_log_id_seq", last_value: "1", is_called: false },
      { seq: "usage_records_id_seq", last_value: "1", is_called: false },
    ]);
  });

  it("leaves audit_log's immutability triggers enabled", async () => {
    await seedRows();

    await resetIntegrationDatabase();

    const rows = (await db.execute<{ tgname: string; tgenabled: string }>(sql`
      SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname
    `)) as unknown as { tgname: string; tgenabled: string }[];
    expect(rows).toEqual([
      { tgname: "no_delete", tgenabled: "O" },
      { tgname: "no_truncate", tgenabled: "O" },
      { tgname: "no_update", tgenabled: "O" },
    ]);
  });

  it("creates no new relation files, so it leaves no fsync debt for DROP DATABASE's checkpoint", async () => {
    await seedRows();
    const before = await relationFiles();
    expect(Object.keys(before).length).toBeGreaterThan(TRACKED.length); // heaps + indexes + more

    await resetIntegrationDatabase();

    expect(await relationFiles()).toEqual(before);
  });

  it("replaces the storage of a vector-indexed table that held rows, so no dead tuples shadow an HNSW search", async () => {
    // An HNSW scan gathers ef_search candidates BEFORE checking visibility, so
    // deleted-but-unvacuumed chunks would crowd live ones out of a later test's
    // retrieval results. Those tables must be emptied by TRUNCATE, not DELETE.
    const [doc] = await db
      .insert(kbDocuments)
      .values({ orgId: "org-reset", contentHash: "h", sourcePath: "/data/a.pdf" })
      .returning();
    await db.insert(kbChunks).values({
      documentId: doc.id,
      orgId: "org-reset",
      sourcePath: "/data/a.pdf",
      chunkText: "x",
      locator: { kind: "page", page: 1 },
      embedding: Array(768).fill(0.1),
    });
    const before = await relationFiles();

    await resetIntegrationDatabase();

    const after = await relationFiles();
    expect(after["idx_kb_chunks_embedding"]).not.toBe(before["idx_kb_chunks_embedding"]);
    expect(after["kb_chunks"]).not.toBe(before["kb_chunks"]);
  });
});
