/**
 * Periodic incremental hash-chain verification for `audit_log` (#584 follow-up).
 *
 * The DB triggers (migration 0008 row-level, 0045 statement-level TRUNCATE
 * guard) and the v3 prevHmac chain (see `verifyIntegrity` in `@/lib/audit`)
 * are tamper-evident, but nothing walks the chain on a schedule — a break
 * introduced via direct DB access (superuser, a doctored backup/replica)
 * would sit undetected until someone happened to call `GET /api/audit/verify`.
 * This job closes that gap the same way `upload-gc.ts` / `chat-error-gc.ts`
 * do: an hourly-ish interval plus a post-startup kick.
 *
 * Incremental, not full-table: `audit_log` grows unboundedly, so re-verifying
 * from row 1 every cycle would get slower forever. A singleton checkpoint row
 * (`audit_verify_state`, id=1) tracks the highest id verified so far; each run
 * only verifies `[lastVerifiedId+1, currentMaxId]`.
 *
 * Boundary-link seeding: the link BETWEEN lastVerifiedId and lastVerifiedId+1
 * is never covered by any single run's own [from, to] window — the row at
 * lastVerifiedId+1 is the first row IN the window, and an unseeded
 * verifyIntegrity() treats the first row of a range as a chain root (its own
 * prevHmac is never compared against anything). An attacker who tampers with
 * exactly that boundary row's prevHmac would therefore slip through
 * incremental verification forever. `lastVerifiedHmac` (the rowHmac of the
 * row at lastVerifiedId) is stored in the checkpoint precisely so it can be
 * passed as `seedPrevHmac`, forcing that boundary link to be checked on every
 * run.
 */
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { auditVerifyState, auditLog } from "@/db/schema";
import { verifyIntegrity, appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

const CHECKPOINT_ID = 1;

// Cap on how many invalid/chain-break ids are embedded in the audit detail.
// appendAuditLog's truncateDetail() already guards the overall 2048-byte
// budget, but capping here keeps the emitted detail readable even for a
// pathological run with thousands of violations.
const MAX_REPORTED_IDS = 50;

// Process-wide counter mirroring getAuditWriteFailedCount() (audit-deferred.ts):
// exposed so health/metrics endpoints can surface a chain-integrity violation
// even if nobody is watching stderr.
let integrityViolationCount = 0;

export function getAuditIntegrityViolationCount(): number {
  return integrityViolationCount;
}

export function resetAuditIntegrityViolationCount(): void {
  integrityViolationCount = 0;
}

interface Checkpoint {
  lastVerifiedId: number;
  lastVerifiedHmac: string | null;
}

async function readCheckpoint(): Promise<Checkpoint> {
  const [row] = await db
    .select({
      lastVerifiedId: auditVerifyState.lastVerifiedId,
      lastVerifiedHmac: auditVerifyState.lastVerifiedHmac,
    })
    .from(auditVerifyState)
    .where(eq(auditVerifyState.id, CHECKPOINT_ID));

  if (!row) {
    // Genesis default: nothing verified yet, no seed (the first ever run's
    // first row IS the true chain genesis, so leaving it unchecked is correct
    // — mirroring verifyIntegrity()'s own un-seeded first-call behavior).
    return { lastVerifiedId: 0, lastVerifiedHmac: null };
  }
  return row;
}

async function writeCheckpoint(
  lastVerifiedId: number,
  lastVerifiedHmac: string | null,
  lastStatus: "ok" | "violation"
): Promise<void> {
  await db
    .insert(auditVerifyState)
    .values({ id: CHECKPOINT_ID, lastVerifiedId, lastVerifiedHmac, lastStatus })
    .onConflictDoUpdate({
      target: auditVerifyState.id,
      set: { lastVerifiedId, lastVerifiedHmac, lastStatus, updatedAt: new Date() },
    });
}

export interface AuditVerifySweepResult {
  scanned: boolean;
  scannedFrom?: number;
  scannedTo?: number;
  valid?: boolean;
  invalidCount?: number;
  chainBreakCount?: number;
}

/**
 * Verify the audit_log rows appended since the last checkpoint and advance
 * the checkpoint regardless of outcome (violations are alarmed on, not
 * spammed on every subsequent run once already reported).
 */
export async function sweepAuditVerify(): Promise<AuditVerifySweepResult> {
  const checkpoint = await readCheckpoint();
  const fromId = checkpoint.lastVerifiedId + 1;

  const result = await verifyIntegrity(fromId, undefined, {
    seedPrevHmac: checkpoint.lastVerifiedHmac,
  });

  if (result.totalChecked === 0) {
    // No new rows since the last checkpoint — nothing to do, checkpoint
    // stays put.
    return { scanned: false };
  }

  // Determine the highest id actually scanned and its rowHmac so the
  // checkpoint can advance to exactly that row (not the current MAX(id),
  // which could race ahead if a row was appended between the scan and here).
  const scannedTo = fromId + result.totalChecked - 1;
  const [lastRow] = await db
    .select({ rowHmac: auditLog.rowHmac })
    .from(auditLog)
    .where(eq(auditLog.id, scannedTo));
  const lastVerifiedHmac = lastRow?.rowHmac ?? null;

  const status: "ok" | "violation" = result.valid ? "ok" : "violation";

  const cappedInvalidIds = result.invalidIds.slice(0, MAX_REPORTED_IDS);
  const cappedChainBreakIds = result.chainBreakIds.slice(0, MAX_REPORTED_IDS);

  const entry = {
    eventType: "audit.integrity_check" as const,
    actorType: "system" as const,
    actorId: "audit-verify-job",
    outcome: (result.valid ? "success" : "failure") as "success" | "failure",
    detail: {
      scannedFrom: fromId,
      scannedTo,
      invalidCount: result.invalidIds.length,
      chainBreakCount: result.chainBreakIds.length,
      invalidIds: cappedInvalidIds,
      chainBreakIds: cappedChainBreakIds,
    },
  };
  // The upcoming appendAuditLog call inserts a new audit_log row: this very
  // audit.integrity_check entry. Folding that row into the checkpoint here
  // (write once, past its own report row) — instead of writing scannedTo
  // first and re-writing again afterward — means the NEXT sweep starts
  // clean of its own prior report and a "no activity since the last sweep"
  // steady state genuinely converges to a no-op instead of perpetually
  // rediscovering exactly one new row (its own last write) forever.
  try {
    await appendAuditLog(entry);
    const [ownRow] = await db
      .select({ id: auditLog.id, rowHmac: auditLog.rowHmac })
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(1);
    // Advance past the sweep's own report row when the write succeeded and a
    // row was actually found; otherwise (write failed, or somehow no row) at
    // minimum advance to the window actually scanned. Advancing even on
    // violation is intentional: re-scanning the same tampered window forever
    // would just re-alarm on every cycle without surfacing new information —
    // the violation is recorded (audit row + stderr + counter) exactly once.
    await writeCheckpoint(ownRow?.id ?? scannedTo, ownRow?.rowHmac ?? lastVerifiedHmac, status);
  } catch (err) {
    recordAuditFailure(err, entry);
    await writeCheckpoint(scannedTo, lastVerifiedHmac, status);
  }

  if (!result.valid) {
    integrityViolationCount++;
    console.error(
      JSON.stringify({
        level: "error",
        event: "audit_integrity_violation",
        invalidCount: result.invalidIds.length,
        chainBreakCount: result.chainBreakIds.length,
      })
    );
  }

  return {
    scanned: true,
    scannedFrom: fromId,
    scannedTo,
    valid: result.valid,
    invalidCount: result.invalidIds.length,
    chainBreakCount: result.chainBreakIds.length,
  };
}

const VERIFY_INTERVAL_MS = Number(process.env.AUDIT_VERIFY_INTERVAL_MS) || 6 * 60 * 60 * 1000;

let _verifyInterval: ReturnType<typeof setInterval> | null = null;
let _verifyStartupTimeout: ReturnType<typeof setTimeout> | null = null;
// Re-entrancy guard: a sweep already in flight (e.g. a huge backlog on first
// run) must not be started again by an overlapping interval tick.
let _sweepInFlight = false;

async function runSweepGuarded(): Promise<void> {
  if (_sweepInFlight) return;
  _sweepInFlight = true;
  try {
    await sweepAuditVerify();
  } catch (err) {
    console.error("[audit-verify-job] sweep failed:", err);
  } finally {
    _sweepInFlight = false;
  }
}

export function startAuditVerifyJob(): void {
  _verifyInterval = setInterval(() => {
    void runSweepGuarded();
  }, VERIFY_INTERVAL_MS);

  _verifyStartupTimeout = setTimeout(() => {
    _verifyStartupTimeout = null;
    void runSweepGuarded();
  }, 60_000);
}

export function stopAuditVerifyJob(): void {
  if (_verifyInterval !== null) {
    clearInterval(_verifyInterval);
    _verifyInterval = null;
  }
  if (_verifyStartupTimeout !== null) {
    clearTimeout(_verifyStartupTimeout);
    _verifyStartupTimeout = null;
  }
}

// Test-only helper (mirrors upload-gc / chat-error-gc pattern).
export function _isAuditVerifyJobRunning(): boolean {
  return _verifyInterval !== null;
}
