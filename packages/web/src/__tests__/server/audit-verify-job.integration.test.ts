// Integration test for the periodic incremental audit-chain verification job
// (audit-verify-job.ts) against a real Postgres database.
//
// The unit test (audit-verify-job.test.ts) mocks verifyIntegrity and the
// checkpoint store, so it can't prove the one thing that actually matters
// here: that resuming verification from a checkpoint, via the real
// `audit_verify_state` table and the real `verifyIntegrity` seedPrevHmac
// option, genuinely closes the boundary-link gap against a real DB. That
// proof — plus a control assertion that the same attack slips through
// WITHOUT the seed — lives here.

import { describe, it, expect, beforeEach } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { appendAuditLog, verifyIntegrity } from "@/lib/audit";
import { db } from "@/db";
import { auditLog, auditVerifyState } from "@/db/schema";
import { sweepAuditVerify } from "@/server/audit-verify-job";

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
    .select({ id: auditLog.id, rowHmac: auditLog.rowHmac, prevHmac: auditLog.prevHmac })
    .from(auditLog)
    .orderBy(asc(auditLog.id));
}

async function readCheckpointRow() {
  const [row] = await db.select().from(auditVerifyState).where(eq(auditVerifyState.id, 1));
  return row ?? null;
}

// Directly delete a row past the immutability trigger, modeling an attacker
// with direct DB access (superuser, doctored backup/replica) — the same
// threat model as audit-chain.integration.test.ts's DELETE test. Deleting
// (rather than UPDATE-ing prev_hmac in place) is the only way to produce a
// genuine chain break: prevHmac is itself part of a v3 row's own HMAC
// payload (computeRowHmacV3), so directly rewriting a row's prev_hmac
// desyncs that row's OWN hash and is caught as a field-tamper (invalidIds),
// not a chain-break, regardless of any seed.
async function deleteRowPastTrigger(id: number) {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_delete`);
  try {
    await db.delete(auditLog).where(eq(auditLog.id, id));
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_delete`);
  }
}

describe("audit-verify-job (integration)", () => {
  beforeEach(async () => {
    // Fresh checkpoint per test — the shared per-test TRUNCATE in
    // src/test-helpers/integration/setup.ts already resets audit_verify_state,
    // this is just documentation of that assumption.
    expect(await readCheckpointRow()).toBeNull();
  });

  it("clean run: verifies the new rows and advances the checkpoint past its own report row", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const rowsBeforeSweep = await allRowsById();

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.scannedFrom).toBe(rowsBeforeSweep[0].id);
    expect(result.scannedTo).toBe(rowsBeforeSweep[2].id);

    // The sweep's own audit.integrity_check row is now in the table too —
    // the checkpoint advances PAST it (not just to the last row scanned) so
    // the next sweep doesn't perpetually rediscover this run's own report.
    const rowsAfterSweep = await allRowsById();
    const ownReportRow = rowsAfterSweep[rowsAfterSweep.length - 1];
    expect(ownReportRow.id).toBe(rowsBeforeSweep[2].id + 1);

    const checkpoint = await readCheckpointRow();
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.lastVerifiedId).toBe(ownReportRow.id);
    expect(checkpoint!.lastVerifiedHmac).toBe(ownReportRow.rowHmac);
    expect(checkpoint!.lastStatus).toBe("ok");
  });

  it("no new rows since the checkpoint: no-op, checkpoint stays put", async () => {
    await appendRow("u1");
    const first = await sweepAuditVerify();
    expect(first.scanned).toBe(true);
    const checkpointAfterFirst = await readCheckpointRow();

    // Nothing was appended (manually or by the job) between these two calls,
    // so the second sweep is a genuine no-op: the checkpoint already covers
    // every row in the table, including the first sweep's own report.
    const second = await sweepAuditVerify();
    expect(second.scanned).toBe(false);

    const checkpointAfterSecond = await readCheckpointRow();
    expect(checkpointAfterSecond).toEqual(checkpointAfterFirst);
  });

  it("field-tamper mid-window: flags the tampered row and still advances + records the violation", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const rows = await allRowsById();

    // Tamper with row 2's own field content (not the chain link): disable
    // no_update, corrupt actor_id directly, which desyncs its stored rowHmac
    // from a recomputed one — a field-tamper, distinct from a chain-break.
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_update`);
    try {
      await db.execute(
        sql`UPDATE audit_log SET actor_id = 'attacker-forged' WHERE id = ${rows[1].id}`
      );
    } finally {
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_update`);
    }

    const result = await sweepAuditVerify();

    expect(result.valid).toBe(false);
    expect(result.invalidCount).toBe(1);

    const checkpoint = await readCheckpointRow();
    expect(checkpoint!.lastStatus).toBe("violation");
    // Checkpoint still advances (past the sweep's own report row) — no
    // alarm-spam loop re-scanning the same tampered window forever.
    expect(checkpoint!.lastVerifiedId).toBe(rows[2].id + 1);
  });

  it("BOUNDARY-SEED ATTACK: deleting the first post-checkpoint row is detected because of seedPrevHmac", async () => {
    // Phase 1: three rows get verified and checkpointed cleanly.
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const firstSweep = await sweepAuditVerify();
    expect(firstSweep.valid).toBe(true);
    const checkpointAfterFirstSweep = await readCheckpointRow();
    expect(checkpointAfterFirstSweep!.lastStatus).toBe("ok");

    // Phase 2: two more rows are appended after the checkpoint.
    await appendRow("u4");
    await appendRow("u5");
    const rows = await allRowsById();
    const boundaryRow = rows[rows.length - 2]; // first row AFTER the checkpoint (u4)
    const afterBoundaryRow = rows[rows.length - 1]; // u5, links to boundaryRow's hmac
    expect(boundaryRow.id).toBe(checkpointAfterFirstSweep!.lastVerifiedId + 1);

    // Attacker deletes the boundary row outright, bypassing the immutability
    // trigger (as in audit-chain.integration.test.ts's DELETE attack test).
    // Every surviving row's own HMAC still verifies — this is purely a
    // deletion, the same threat model as the existing mid-chain DELETE test,
    // but positioned exactly at the seam an incremental verifier resumes from.
    await deleteRowPastTrigger(boundaryRow.id);

    // Control assertion: WITHOUT the seed, verifyIntegrity treats the first
    // row of the [afterBoundaryRow.id, ...] window as a chain root and the
    // deletion slips through undetected — proving the boundary gap the seed
    // is meant to close. (Scanning from boundaryRow.id would find nothing —
    // it's gone — so the window naturally starts at afterBoundaryRow.id,
    // exactly mirroring what an unseeded incremental verifier would do.)
    const unseeded = await verifyIntegrity(afterBoundaryRow.id, undefined);
    expect(unseeded.valid).toBe(true);
    expect(unseeded.chainBreakIds).toEqual([]);

    // The real fix: sweepAuditVerify seeds prevHmac from the checkpoint, so
    // the same deletion IS detected as a chain break.
    const secondSweep = await sweepAuditVerify();
    expect(secondSweep.valid).toBe(false);
    expect(secondSweep.chainBreakCount).toBeGreaterThanOrEqual(1);

    const checkpointAfterSecondSweep = await readCheckpointRow();
    expect(checkpointAfterSecondSweep!.lastStatus).toBe("violation");
  });
});
