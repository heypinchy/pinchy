// Derived guard: every FK whose delete action WRITES to the referencing side
// (`cascade`, `set null`, `set default`) must have an index the referencing
// side can use to find those rows.
//
// Postgres indexes the *referenced* key automatically (it has to be unique) and
// indexes the *referencing* side never. So a `DELETE FROM groups WHERE id = ?`
// with `invite_groups.group_id ON DELETE CASCADE` behind it does a sequential
// scan of `invite_groups` per deleted row — and `gated-config.ts` deletes every
// group in one statement when the enterprise gate lapses.
//
// This exists because the list it replaces was hand-maintained. The change that
// added it (#1097) picked four such gaps by inspection, fixed three of them, and
// introduced a fifth: the `set null` rule it added to `email_workflows.created_by`
// needs exactly the same index a cascade does, and had none. That is the failure
// mode AGENTS.md § "A Hand-Maintained List That Mirrors Code Will Be Wrong"
// describes — so the list is now derived from the live database instead of from
// somebody reading the schema.
//
// It reads the MIGRATED database, not `db/schema.ts`, for the same reason the
// X-Frame-Options guard reads a resolved URL: what ships is the migration, and a
// schema declaration that never made it into one would pass a source-level check.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * FKs deliberately left without a supporting index, keyed by constraint name and
 * carrying the reason. Empty today, and an entry is checked against reality
 * below — a verdict must not outlive its evidence. Adding one is a claim that
 * the referencing table stays small enough for a sequential scan to be free, so
 * write down which delete path pays it.
 */
const ACCEPTED_WITHOUT_INDEX: Record<string, string> = {};

/** `pg_constraint.confdeltype` codes that write to the referencing side. */
const WRITING_DELETE_ACTIONS = ["c", "n", "d"] as const;
const ACTION_NAMES: Record<string, string> = {
  c: "cascade",
  n: "set null",
  d: "set default",
};

interface ForeignKey {
  constraint_name: string;
  table_name: string;
  delete_action: string;
  columns: string[];
}

interface IndexRow {
  table_name: string;
  index_name: string;
  key_columns: string[];
}

async function cascadingForeignKeys(): Promise<ForeignKey[]> {
  return (await db.execute(sql`
    SELECT
      con.conname::text AS constraint_name,
      cls.relname::text AS table_name,
      con.confdeltype::text AS delete_action,
      ARRAY(
        SELECT att.attname::text
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        ORDER BY k.ord
      ) AS columns
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND con.confdeltype::text IN (${sql.join(
        WRITING_DELETE_ACTIONS.map((a) => sql`${a}`),
        sql`, `
      )})
    ORDER BY cls.relname, con.conname
  `)) as unknown as ForeignKey[];
}

/**
 * Every usable index, as its ordered list of leading key columns.
 *
 * Partial indexes (`indpred IS NOT NULL`) are excluded on purpose: they cover a
 * subset of rows, so the planner cannot use one to find *all* referencing rows.
 * `email_workflows_enabled_idx` is exactly such an index, and counting it would
 * have hidden the gap this file was written for. INCLUDE columns are excluded
 * too (`indnkeyatts`) — they are payload, not searchable prefix. Primary keys and
 * unique constraints need no special case: they are ordinary `pg_index` rows.
 */
async function usableIndexes(): Promise<IndexRow[]> {
  return (await db.execute(sql`
    SELECT
      tbl.relname::text AS table_name,
      idx.relname::text AS index_name,
      ARRAY(
        SELECT pg_get_indexdef(i.indexrelid, k, true)
        FROM generate_series(1, i.indnkeyatts) AS k
        ORDER BY k
      ) AS key_columns
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND i.indisvalid
      AND i.indpred IS NULL
    ORDER BY tbl.relname, idx.relname
  `)) as unknown as IndexRow[];
}

/**
 * An index supports the FK when its LEADING key columns are exactly the FK's
 * columns. Order within that prefix does not matter — a btree on `(b, a)` serves
 * `WHERE a = ? AND b = ?` — but a column in front of them does: `(user_id,
 * notification_id)` cannot find rows by `notification_id` alone, which is the
 * `notification_recipients` primary key and the reason that table needed a
 * second index at all.
 */
function supportingIndex(fk: ForeignKey, indexes: IndexRow[]): IndexRow | undefined {
  const wanted = new Set(fk.columns);
  return indexes.find((ix) => {
    if (ix.table_name !== fk.table_name) return false;
    if (ix.key_columns.length < fk.columns.length) return false;
    const lead = ix.key_columns.slice(0, fk.columns.length);
    return lead.length === wanted.size && lead.every((c) => wanted.has(c));
  });
}

describe("cascading FKs have a supporting index on the referencing side (#1097)", () => {
  it("finds every FK that writes to the referencing side on delete", async () => {
    const fks = await cascadingForeignKeys();
    const indexes = await usableIndexes();

    // A query that silently stopped matching would make this file pass while
    // checking nothing. The schema had 32 such FKs when the guard landed.
    expect(fks.length, "cascading-FK query returned an implausibly small corpus").toBeGreaterThan(
      25
    );
    expect(indexes.length, "index query returned an implausibly small corpus").toBeGreaterThan(40);

    const unsupported = fks
      .filter((fk) => !supportingIndex(fk, indexes))
      .filter((fk) => !(fk.constraint_name in ACCEPTED_WITHOUT_INDEX))
      .map(
        (fk) =>
          `${fk.table_name}(${fk.columns.join(", ")}) ON DELETE ${ACTION_NAMES[fk.delete_action]} ` +
          `— no index leads with (${fk.columns.join(", ")}); add one in db/schema.ts and generate ` +
          `the migration, or accept it in ACCEPTED_WITHOUT_INDEX [${fk.constraint_name}]`
      );

    expect(unsupported).toEqual([]);
  });

  it("keeps every accepted exemption pinned to a gap that still exists", async () => {
    const fks = await cascadingForeignKeys();
    const indexes = await usableIndexes();
    const byName = new Map(fks.map((fk) => [fk.constraint_name, fk]));

    for (const [constraintName, reason] of Object.entries(ACCEPTED_WITHOUT_INDEX)) {
      expect(reason.length, `exemption ${constraintName} needs a written reason`).toBeGreaterThan(
        20
      );
      const fk = byName.get(constraintName);
      expect(
        fk,
        `exemption ${constraintName} names no cascading FK — stale, remove it`
      ).toBeDefined();
      expect(
        supportingIndex(fk!, indexes),
        `exemption ${constraintName} is indexed now — remove the exemption`
      ).toBeUndefined();
    }
  });
});
