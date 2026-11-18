// Integration test for the periodic incremental audit-chain verification job
// (audit-verify-job.ts) against a real Postgres database.
//
// The unit test (audit-verify-job.test.ts) mocks verifyIntegrity and the
// checkpoint store, so it can't prove the one thing that actually matters
// here: that resuming verification from a checkpoint, via the real
// `audit_verify_state` table and the real `verifyIntegrity` seedPrevHmac
// option, genuinely closes the boundary-link gap against a real DB. That
// proof — plus a control assertion that the same attack slips through
// WITHOUT the seed — lives here. So does the #698 proof that a row appended
// concurrently with a sweep is picked up by the NEXT sweep instead of falling
// through the checkpoint fold, which likewise only means something against
// real ids and a real chain.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import {
  appendAuditLog,
  computeRowHmacV3,
  isActiveKeySeenBefore,
  verifyIntegrity,
} from "@/lib/audit";
import { db } from "@/db";
import { auditLog, auditVerifyState } from "@/db/schema";
import { sweepAuditVerify } from "@/server/audit-verify-job";

// Hook for the #698 concurrency test: when armed, one real audit row is
// appended right BEFORE the sweep writes its own report row — i.e. inside the
// window between the sweep's MAX(id) snapshot and its report. That window is
// milliseconds wide in production and can't be hit reliably from the outside,
// so we interpose on the sweep's own append instead of racing it. Everything
// else stays real: real DB, real hash chain, real verifyIntegrity.
const { raceState } = vi.hoisted(() => ({ raceState: { armed: false } }));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    appendAuditLog: async (entry: Parameters<typeof actual.appendAuditLog>[0]) => {
      if (raceState.armed && entry.eventType === "audit.integrity_check") {
        raceState.armed = false;
        await actual.appendAuditLog({
          actorType: "user",
          actorId: "racer",
          eventType: "auth.login",
          resource: "user:racer",
          outcome: "success",
        });
      }
      return actual.appendAuditLog(entry);
    },
  };
});

async function appendRow(actorId: string) {
  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "auth.login",
    resource: `user:${actorId}`,
    // `detail` is optional for `auth.*` events (Record<string, unknown> |
    // undefined — not `null`). appendAuditLog itself falls back to `null`
    // internally (`entry.detail ?? null`), so omitting it stores the same
    // `null` detail as before without a type error.
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
    // Only the #698 test arms the concurrent-append interposer; make sure a
    // leftover arming can never bleed into another test's row sequence.
    raceState.armed = false;
    // Fresh checkpoint per test — the shared per-test reset in
    // src/test-helpers/integration/reset-db.ts already empties audit_verify_state,
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

  it("DELETED CHECKPOINT ROW: the next sweep reports the boundary link as broken", async () => {
    // The checkpoint remembers the rowHmac of the row it ends on, and the next
    // window's first link still matches that remembered value after the row
    // itself is gone. Only comparing the row as it is now with what the
    // checkpoint remembered notices the deletion.
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const checkpoint = await readCheckpointRow();

    await appendRow("u3");
    await deleteRowPastTrigger(checkpoint!.lastVerifiedId);

    const second = await sweepAuditVerify();

    expect(second.scanned).toBe(true);
    expect(second.valid).toBe(false);
    expect(second.chainBreakCount).toBe(1);
    expect((await readCheckpointRow())!.lastStatus).toBe("violation");
  });

  it("DELETED CHECKPOINT ROW AT THE TIP: only the sweep reports it, a full verification is clean", async () => {
    // The checkpoint is usually the sweep's own report row, the newest row on a
    // quiet instance. Deleted while it is still the newest, it leaves no gap in
    // the chain: the next appended row links to the row before it. A full
    // verification walks a consistent chain and finds nothing. Only the sweep,
    // which compares the window's first link with the hash it remembered, sees
    // the deletion, so its chain break has to stand on its own.
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const checkpoint = await readCheckpointRow();
    const rowsBeforeDelete = await allRowsById();
    expect(rowsBeforeDelete[rowsBeforeDelete.length - 1].id).toBe(checkpoint!.lastVerifiedId);

    await deleteRowPastTrigger(checkpoint!.lastVerifiedId);
    await appendRow("u3");
    await appendRow("u4");
    const [u3] = (await allRowsById()).filter((r) => r.id > checkpoint!.lastVerifiedId);

    const second = await sweepAuditVerify();

    expect(second.valid).toBe(false);
    expect(second.chainBreakCount).toBe(1);
    const [failure] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.eventType, "audit.integrity_check"))
      .orderBy(sql`${auditLog.id} desc`)
      .limit(1);
    expect(failure.detail).toMatchObject({ chainBreakIds: [u3.id] });

    const full = await verifyIntegrity();
    expect(full.valid).toBe(true);
    expect(full.chainBreakIds).toEqual([]);
    expect(full.invalidIds).toEqual([]);
  });

  it("CONCURRENT APPEND during the sweep: the raced row is verified by the next sweep, not skipped forever (#698)", async () => {
    await appendRow("u1");
    await appendRow("u2");
    const rowsBeforeSweep = await allRowsById();
    const lastPreSweepRow = rowsBeforeSweep[rowsBeforeSweep.length - 1];

    // Arm the interposer: one real row lands between the sweep's MAX(id)
    // snapshot and its own report row, i.e. in the (toId, reportId) window
    // that neither this sweep (> toId) nor a report-folded checkpoint
    // (< reportId + 1) would ever cover.
    raceState.armed = true;
    const firstSweep = await sweepAuditVerify();
    expect(firstSweep.scanned).toBe(true);
    expect(firstSweep.scannedTo).toBe(lastPreSweepRow.id);

    const rowsAfterSweep = await allRowsById();
    const racedRow = rowsAfterSweep[rowsAfterSweep.length - 2];
    const reportRow = rowsAfterSweep[rowsAfterSweep.length - 1];
    // Sanity: the interposer really produced the (toId, reportId) window.
    expect(racedRow.id).toBeGreaterThan(lastPreSweepRow.id);
    expect(racedRow.id).toBeLessThan(reportRow.id);

    // The fix: because a row exists in that window, the checkpoint is folded
    // only to the window actually scanned instead of past the report row.
    const checkpoint = await readCheckpointRow();
    expect(checkpoint!.lastVerifiedId).toBe(lastPreSweepRow.id);
    expect(checkpoint!.lastVerifiedHmac).toBe(lastPreSweepRow.rowHmac);
    expect(checkpoint!.lastStatus).toBe("ok");

    // Self-healing: the next sweep re-scans the raced row AND the previous
    // sweep's own report row — with the chain seeded from the checkpoint, so
    // the boundary link into the raced row is checked too.
    const secondSweep = await sweepAuditVerify();
    expect(secondSweep.scanned).toBe(true);
    expect(secondSweep.valid).toBe(true);
    expect(secondSweep.scannedFrom).toBe(lastPreSweepRow.id + 1);
    expect(secondSweep.scannedTo).toBe(reportRow.id);

    // …and converges: nothing raced the second sweep, so it folded past its
    // own report and the third sweep is a genuine no-op again.
    const third = await sweepAuditVerify();
    expect(third.scanned).toBe(false);
  });

  it("SEQUENCE GAP: scannedTo reflects the true highest scanned id, not fromId + count - 1", async () => {
    await appendRow("u1");
    await appendRow("u2");
    const rowsBeforeGap = await allRowsById();

    // Model a rolled-back transaction consuming sequence values without
    // leaving a row: bump the id sequence by 5 so the next inserted row's id
    // jumps ahead, leaving a gap in [fromId, true max]. Postgres serial
    // sequences are NOT guaranteed gapless — this is a normal, common
    // occurrence, not an attack.
    await db.execute(
      sql`SELECT setval(pg_get_serial_sequence('audit_log', 'id'), (SELECT MAX(id) FROM audit_log) + 5)`
    );

    await appendRow("u3");
    const rowsAfterGap = await allRowsById();
    const lastRow = rowsAfterGap[rowsAfterGap.length - 1];

    // Sanity: the gap actually happened (id jumped by more than 1).
    expect(lastRow.id).toBeGreaterThan(rowsBeforeGap[rowsBeforeGap.length - 1].id + 1);

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(true);
    expect(result.valid).toBe(true);
    // The buggy arithmetic (fromId + totalChecked - 1) would UNDERESTIMATE
    // scannedTo here because totalChecked counts only the 3 real rows while
    // the id space spans the gap. The true highest scanned id is lastRow.id.
    expect(result.scannedTo).toBe(lastRow.id);

    const checkpoint = await readCheckpointRow();
    expect(checkpoint!.lastStatus).toBe("ok");
    // The checkpoint must be seeded with a real row's hmac (from an id that
    // actually exists), not a phantom id computed via the gappy arithmetic —
    // otherwise the next sweep's chain-seed lookup would miss and could
    // raise a false chainBreak alarm.
    expect(checkpoint!.lastVerifiedHmac).not.toBeNull();

    // Next sweep must be a clean no-op: no false chainBreak alarm from a
    // checkpoint that pointed at a non-existent or wrong row.
    const secondSweep = await sweepAuditVerify();
    expect(secondSweep.scanned).toBe(false);
  });
});

// The previous signing key is only trusted for the rows that pre-date the
// rotation. The full-range verifier knows that from the rows it walks; the
// incremental sweep sees one window at a time, so without help a window of
// forged old-key rows that follows an active-key checkpoint looks like a
// legitimate pre-rotation prefix. These prove the sweep carries the rotation
// across the checkpoint.
describe("audit-verify-job across a signing-secret rotation (integration)", () => {
  const previousSecretHex = "ab".repeat(32);
  const previousSecret = Buffer.from(previousSecretHex, "hex");
  let secretsDir: string;
  let originalKeyDir: string | undefined;

  beforeEach(() => {
    // AUDIT_HMAC_SECRET is pinned by the integration config (the active key).
    // A different key file in the secrets dir is, by getPreviousSecret's
    // definition, the key that pin superseded.
    originalKeyDir = process.env.ENCRYPTION_KEY_DIR;
    secretsDir = mkdtempSync(join(tmpdir(), "audit-prev-key-"));
    writeFileSync(join(secretsDir, ".audit_hmac_secret"), previousSecretHex);
    process.env.ENCRYPTION_KEY_DIR = secretsDir;
  });

  afterEach(() => {
    if (originalKeyDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
    else process.env.ENCRYPTION_KEY_DIR = originalKeyDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  // Re-sign a stored row under the previous key, as someone holding the old
  // key file and DB write access would (immutability trigger bypassed).
  async function resignUnderPreviousKey(id: number, actorId?: string) {
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id));
    const newActorId = actorId ?? row.actorId;
    const rowHmac = computeRowHmacV3(previousSecret, {
      timestamp: row.timestamp,
      eventType: row.eventType,
      actorType: row.actorType,
      actorId: newActorId,
      resource: row.resource,
      detail: row.detail,
      outcome: (row.outcome ?? "success") as "success" | "failure",
      error: row.error as { message: string } | null,
      prevHmac: row.prevHmac,
    });
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_update`);
    try {
      await db.execute(
        sql`UPDATE audit_log SET actor_id = ${newActorId}, row_hmac = ${rowHmac} WHERE id = ${id}`
      );
    } finally {
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_update`);
    }
    return rowHmac;
  }

  // Re-sign every row in the table, in order, under `key`, threading the chain:
  // re-signing changes rowHmac, so the next row's prevHmac must follow. Models
  // history that was written while `key` was the active key. Returns the last
  // row's { id, rowHmac }.
  async function resignChainUnder(key: Buffer) {
    const rows = await allRowsById();
    let prev: string | null = null;
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_update`);
    try {
      for (const r of rows) {
        const [row] = await db.select().from(auditLog).where(eq(auditLog.id, r.id));
        const rowHmac = computeRowHmacV3(key, {
          timestamp: row.timestamp,
          eventType: row.eventType,
          actorType: row.actorType,
          actorId: row.actorId,
          resource: row.resource,
          detail: row.detail,
          outcome: (row.outcome ?? "success") as "success" | "failure",
          error: row.error as { message: string } | null,
          prevHmac: prev,
        });
        await db.execute(
          sql`UPDATE audit_log SET prev_hmac = ${prev}, row_hmac = ${rowHmac} WHERE id = ${r.id}`
        );
        prev = rowHmac;
      }
    } finally {
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_update`);
    }
    return { id: rows[rows.length - 1].id, rowHmac: prev! };
  }

  // Change a stored row's content past the immutability trigger and leave its
  // row_hmac alone: the stored hash string stays the one the sweep remembered.
  async function alterContentInPlace(id: number) {
    await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_update`);
    try {
      await db.execute(sql`UPDATE audit_log SET detail = '{}'::jsonb WHERE id = ${id}`);
    } finally {
      await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_update`);
    }
  }

  it("flags an old-key row that appears in a later window than the active-key rows", async () => {
    await appendRow("u1");
    await appendRow("u2");
    const first = await sweepAuditVerify();
    expect(first.valid).toBe(true);

    // After the rotation: a row written under the active key, then rewritten
    // under the leaked old key. It is alone in the second window, with no
    // active-key row inside that window to precede it.
    await appendRow("u3");
    const rows = await allRowsById();
    await resignUnderPreviousKey(rows[rows.length - 1].id, "forged-after-rotation");

    const second = await sweepAuditVerify();

    expect(second.scanned).toBe(true);
    expect(second.invalidCount).toBe(1);
    expect(second.previousKeyCount).toBe(0);
    expect(second.valid).toBe(false);
  });

  it("flags old-key rows after a checkpoint row that was itself re-signed with the old key", async () => {
    // The checkpoint row decides whether the next window may still contain
    // pre-rotation rows. Re-signing that row with the leaked old key would make
    // it look pre-rotation, and every row after it could then be re-signed the
    // same way and pass as history. Each row's stored link stays untouched, so
    // nothing in the chain itself gives it away.
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const checkpoint = await readCheckpointRow();

    await appendRow("u3");
    const rows = await allRowsById();
    await resignUnderPreviousKey(checkpoint!.lastVerifiedId);
    await resignUnderPreviousKey(rows[rows.length - 1].id, "forged-after-rotation");

    const second = await sweepAuditVerify();

    expect(second.scanned).toBe(true);
    expect(second.previousKeyCount).toBe(0);
    expect(second.invalidCount).toBe(1);
    expect(second.valid).toBe(false);
  });

  it("reports a re-signed checkpoint row as a broken link even when the rows after it are untouched", async () => {
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const checkpoint = await readCheckpointRow();

    await appendRow("u3");
    await resignUnderPreviousKey(checkpoint!.lastVerifiedId);

    const second = await sweepAuditVerify();

    expect(second.valid).toBe(false);
    expect(second.invalidCount).toBe(0);
    expect(second.chainBreakCount).toBe(1);
  });

  // The checkpoint is the last report row signed under the earlier key, rows
  // signed under it follow, then the key switches. Before the first sweep under
  // the new key, the checkpoint row is deleted. The sweep must name the deletion
  // as a chain break on the window's first row, although that row only verifies
  // under the earlier key and the broken checkpoint closes that key for the
  // window. A full verification then tells the untouched pre-switch rows apart.
  it("reports a deleted earlier-key checkpoint row as a chain break on the window's first row", async () => {
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const reportId = (await readCheckpointRow())!.lastVerifiedId;
    await appendRow("u3");
    await appendRow("u4");
    // Everything so far was written while the earlier key was active.
    await resignChainUnder(previousSecret);
    const report = (await allRowsById()).find((r) => r.id === reportId)!;
    await db
      .update(auditVerifyState)
      .set({ lastVerifiedHmac: report.rowHmac })
      .where(eq(auditVerifyState.id, 1));
    const [u3, u4] = (await allRowsById()).filter((r) => r.id > reportId);

    // The switch: this row is signed under the active key.
    await appendRow("u5");
    await deleteRowPastTrigger(reportId);

    const second = await sweepAuditVerify();

    expect(second.valid).toBe(false);
    expect(second.chainBreakCount).toBe(1);
    const [failure] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.eventType, "audit.integrity_check"))
      .orderBy(sql`${auditLog.id} desc`)
      .limit(1);
    expect(failure.detail).toMatchObject({
      chainBreakIds: [u3.id],
      // The run can't place the key change any more, so the earlier-key rows in
      // its window aren't accepted as pre-change history.
      invalidIds: [u3.id, u4.id],
      previousKeyCount: 0,
    });

    // A full verification establishes the change point from the first row:
    // the untouched pre-switch rows are signed with the earlier key, and the
    // deletion is the only finding.
    const full = await verifyIntegrity();
    expect(full.invalidIds).toEqual([]);
    expect(full.chainBreakIds).toEqual([u3.id]);
    expect(full.previousKeyIds).toEqual(expect.arrayContaining([u3.id, u4.id]));
  });

  // Same as above, except the earlier-key checkpoint row is deleted while it is
  // still the newest row, before u3 and u4 are written. They link to the row
  // before it, so the chain has no gap: a full verification places the change
  // point and is clean, and the sweep's failure entry is the only record of the
  // deletion.
  it("reports a deleted earlier-key checkpoint row that was the newest row only in the sweep", async () => {
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const reportId = (await readCheckpointRow())!.lastVerifiedId;
    await deleteRowPastTrigger(reportId);
    await appendRow("u3");
    await appendRow("u4");
    // Everything so far was written while the earlier key was active.
    await resignChainUnder(previousSecret);
    const [u3, u4] = (await allRowsById()).filter((r) => r.id > reportId);

    // The switch: this row is signed under the active key.
    await appendRow("u5");

    const second = await sweepAuditVerify();

    expect(second.valid).toBe(false);
    expect(second.chainBreakCount).toBe(1);
    const [failure] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.eventType, "audit.integrity_check"))
      .orderBy(sql`${auditLog.id} desc`)
      .limit(1);
    expect(failure.detail).toMatchObject({
      chainBreakIds: [u3.id],
      invalidIds: [u3.id, u4.id],
      previousKeyCount: 0,
    });

    const full = await verifyIntegrity();
    expect(full.valid).toBe(true);
    expect(full.chainBreakIds).toEqual([]);
    expect(full.invalidIds).toEqual([]);
    expect(full.previousKeyIds).toEqual(expect.arrayContaining([u3.id, u4.id]));
  });

  // Content-only tampering: the checkpoint row's content changes, its row_hmac
  // does not. The remembered hash still matches, so the row reads as intact,
  // but it verifies under no key any more. Read as "not signed under the active
  // key", that re-opened the old key for the whole next window and a forged
  // old-key row after it passed as pre-change history.
  it("flags an old-key row after a checkpoint row whose content was altered in place", async () => {
    await appendRow("u1");
    await appendRow("u2");
    expect((await sweepAuditVerify()).valid).toBe(true);
    const checkpoint = await readCheckpointRow();

    await appendRow("u3");
    const rows = await allRowsById();
    await alterContentInPlace(checkpoint!.lastVerifiedId);
    await resignUnderPreviousKey(rows[rows.length - 1].id, "forged-after-rotation");

    const second = await sweepAuditVerify();

    expect(second.scanned).toBe(true);
    expect(second.previousKeyCount).toBe(0);
    expect(second.invalidCount).toBe(1);
    expect(second.valid).toBe(false);
  });

  // A second rotation: K1 is still the key file (the previous key), K2 signed
  // the history up to the checkpoint, K3 is the active env key now. K2 is held
  // nowhere any more, so the checkpoint row verifies under neither key. That is
  // a legitimate install, and the sweep must not record a violation for it.
  it("does not alarm on a checkpoint row signed under a key retired by a second rotation", async () => {
    const k2 = Buffer.from("cd".repeat(32), "hex");
    await appendRow("u1");
    await appendRow("u2");
    const last = await resignChainUnder(k2);
    // The sweep that ran while K2 was active verified up to here.
    await db
      .insert(auditVerifyState)
      .values({ id: 1, lastVerifiedId: last.id, lastVerifiedHmac: last.rowHmac, lastStatus: "ok" });

    // Written under K3 after the restart, chained to the last K2 row.
    await appendRow("u3");

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(true);
    expect(result.chainBreakCount).toBe(0);
    expect(result.invalidCount).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("a partial range whose predecessor was altered in place does not re-open the old key", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const rows = await allRowsById();
    const forged = rows[2];
    await alterContentInPlace(rows[1].id);
    await resignUnderPreviousKey(forged.id, "forged-after-rotation");

    expect(await isActiveKeySeenBefore(forged.id)).toBe(true);
    const seeded = await verifyIntegrity(forged.id, undefined, {
      seedActiveKeySeen: await isActiveKeySeenBefore(forged.id),
    });
    expect(seeded.invalidIds).toEqual([forged.id]);
    expect(seeded.previousKeyIds).toEqual([]);
  });

  // GET /api/audit/verify?fromId= seeds its range this way. Lives here because
  // this describe owns the two-key setup; the route's own test pins the wiring.
  it("a partial range past the key change takes its key context from the row before it", async () => {
    await appendRow("u1");
    await appendRow("u2");
    await appendRow("u3");
    const rows = await allRowsById();
    const forged = rows[2];
    await resignUnderPreviousKey(forged.id, "forged-after-rotation");

    // Control: unseeded, the range can't see that row 2 was already under the
    // active key, and the forged row passes as pre-change history.
    const unseeded = await verifyIntegrity(forged.id, undefined);
    expect(unseeded.previousKeyIds).toEqual([forged.id]);
    expect(unseeded.valid).toBe(true);

    expect(await isActiveKeySeenBefore(forged.id)).toBe(true);
    const seeded = await verifyIntegrity(forged.id, undefined, {
      seedActiveKeySeen: await isActiveKeySeenBefore(forged.id),
    });
    expect(seeded.invalidIds).toEqual([forged.id]);
    expect(seeded.previousKeyIds).toEqual([]);
    expect(seeded.valid).toBe(false);
  });

  it("still reports a legitimately rotated chain (old-key rows, then active rows) as valid", async () => {
    await appendRow("u1");
    await appendRow("u2");
    // Model the pre-rotation history: both rows were signed under the key that
    // was later superseded.
    await resignChainUnder(previousSecret);

    // Sweep 1 covers only old-key rows: nothing active yet, so the prefix holds.
    const first = await sweepAuditVerify();
    expect(first.valid).toBe(true);
    expect(first.previousKeyCount).toBe(2);

    // Active-key rows after the rotation verify normally in the next window.
    await appendRow("u3");
    const second = await sweepAuditVerify();
    expect(second.valid).toBe(true);
    expect(second.previousKeyCount).toBe(0);
  });
});
