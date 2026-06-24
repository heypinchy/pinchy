// Integration test for the v3 audit hash-chain against a real Postgres DB.
//
// The unit tests for appendAuditLog/verifyIntegrity mock the transaction and
// the advisory lock, so they cannot prove the parts that only exist at the DB
// edge:
//   • appendAuditLog writes version 3 with prevHmac linking to the real
//     immediately-preceding row,
//   • pg_advisory_xact_lock actually serializes concurrent appends so the
//     chain never forks (two writers reading the same predecessor),
//   • verifyIntegrity detects a row deleted directly via SQL.
//
// These are exactly the failure modes a mocked test stays green through while
// production breaks, so they get a real-DB guardrail here.

import { describe, it, expect } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { appendAuditLog, verifyIntegrity } from "@/lib/audit";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

async function appendRow(actorId: string) {
  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "auth.login",
    resource: `user:${actorId}`,
    detail: null,
    outcome: "success",
  });
}

async function allRowsById() {
  return db
    .select({
      id: auditLog.id,
      version: auditLog.version,
      rowHmac: auditLog.rowHmac,
      prevHmac: auditLog.prevHmac,
    })
    .from(auditLog)
    .orderBy(asc(auditLog.id));
}

describe("v3 audit hash-chain (integration)", () => {
  it("links each appended row to its predecessor and verifies the intact chain", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");

    const rows = await allRowsById();
    expect(rows).toHaveLength(3);
    // Every row is written at v3 and the chain links are real predecessor hashes.
    expect(rows.every((r) => r.version === 3)).toBe(true);
    expect(rows[0].prevHmac).toBeNull(); // genesis
    expect(rows[1].prevHmac).toBe(rows[0].rowHmac);
    expect(rows[2].prevHmac).toBe(rows[1].rowHmac);

    const result = await verifyIntegrity();
    expect(result).toEqual({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
    });
  });

  it("rejects a normal DELETE via the immutability trigger (defense layer above the chain)", async () => {
    await appendRow("u1");
    const [row] = await allRowsById();
    // The DB trigger (migration 0008) is the first line of defense: an ordinary
    // attempt to mutate audit_log is refused outright (the "immutable" message
    // arrives wrapped in the driver's query error, so assert behaviorally).
    await expect(db.delete(auditLog).where(eq(auditLog.id, row.id))).rejects.toThrow();
    // The row survived — the delete never took effect.
    expect(await allRowsById()).toHaveLength(1);
  });

  it("flags a row deleted past the immutability trigger as a chain break", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const before = await allRowsById();
    const middleId = before[1].id;

    // Model an attacker with direct DB access who bypasses the immutability
    // trigger (e.g. superuser, a doctored backup, replication tampering). The
    // hash-chain is the tripwire BELOW that trigger: every surviving row's own
    // HMAC still verifies, so only the broken chain link exposes the deletion.
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_delete`);
    try {
      await db.delete(auditLog).where(eq(auditLog.id, middleId));
    } finally {
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_delete`);
    }

    const result = await verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual([]);
    expect(result.chainBreakIds).toEqual([before[2].id]);
  });

  it("serializes concurrent appends into a single linear chain (no fork)", async () => {
    // Fire many appends concurrently. Without pg_advisory_xact_lock two of them
    // could read the same predecessor rowHmac and both link to it, forking the
    // chain — which verifyIntegrity would then (correctly) flag. With the lock,
    // the appends serialize and the chain stays linear and valid.
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendRow(`c${i}`)));

    const rows = await allRowsById();
    expect(rows).toHaveLength(12);

    // Each row (after the genesis) links to exactly the row before it by id —
    // the defining property of an un-forked chain.
    expect(rows[0].prevHmac).toBeNull();
    let prevHmac = rows[0].rowHmac;
    for (const row of rows.slice(1)) {
      expect(row.prevHmac).toBe(prevHmac);
      prevHmac = row.rowHmac;
    }

    const result = await verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.chainBreakIds).toEqual([]);
    expect(result.totalChecked).toBe(12);
  });
});
