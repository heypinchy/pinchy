/**
 * Periodic incremental hash-chain verification for `audit_log` (#584 follow-up).
 *
 * The DB triggers (migration 0008 row-level, 0047 statement-level TRUNCATE
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
import { eq, desc, and, gt, gte, lt, lte, sql } from "drizzle-orm";
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
    // Genesis default: nothing verified yet. lastVerifiedHmac stays null, which
    // sweepAuditVerify passes as `seedPrevHmac: null` — that DOES check the
    // first row of the first window, asserting it is the true chain genesis
    // (its prevHmac must be null). This also catches a deleted row 1: a
    // surviving row 2 whose prevHmac is non-null would be flagged against the
    // null seed. (Distinct from omitting the seed entirely, which would leave
    // that first row unchecked.)
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

/**
 * Did another writer land a row in the open interval (afterId, beforeId)?
 *
 * Used to detect a concurrent append that happened between this sweep's
 * MAX(id) snapshot and its own report row (#698). The answer is trustworthy
 * despite the read happening outside any of those transactions: appendAuditLog
 * allocates the id and commits while holding the chain's advisory xact lock,
 * so id order IS commit order — once the report row at `beforeId` is visible,
 * every row below it that will ever exist is committed and visible too.
 *
 * Adjacent ids leave no room for a row in between, so the common uncontended
 * case (report row directly after the snapshot) answers without a query.
 *
 * An unanswerable probe answers "yes". This runs AFTER the report row is
 * already written, so letting the error escape would leave the checkpoint
 * behind entirely and make the next sweep re-scan and re-report the identical
 * window. "Assume someone raced us" costs at most a redundant re-scan and can
 * never skip a row — the same conservative direction as the audit-write
 * failure fallback below.
 */
async function hasRowsBetween(afterId: number, beforeId: number): Promise<boolean> {
  if (beforeId <= afterId + 1) return false;

  try {
    const [row] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(gt(auditLog.id, afterId), lt(auditLog.id, beforeId)))
      .limit(1);

    return row !== undefined;
  } catch (err) {
    console.error("[audit-verify-job] concurrency probe failed, folding conservatively:", err);
    return true;
  }
}

export interface AuditVerifySweepResult {
  scanned: boolean;
  scannedFrom?: number;
  scannedTo?: number;
  valid?: boolean;
  invalidCount?: number;
  chainBreakCount?: number;
  // Rows in this window that verified under the superseded signing secret. Not
  // a violation — see the report entry below.
  previousKeyCount?: number;
}

/**
 * Verify the audit_log rows appended since the last checkpoint and advance
 * the checkpoint regardless of outcome (violations are alarmed on, not
 * spammed on every subsequent run once already reported).
 */
export async function sweepAuditVerify(): Promise<AuditVerifySweepResult> {
  const checkpoint = await readCheckpoint();
  const fromId = checkpoint.lastVerifiedId + 1;

  // Snapshot the upper bound BEFORE verifying so the scan window is fixed:
  // otherwise a row appended concurrently with verifyIntegrity() could be
  // scanned but then miscounted against a `toId` that raced ahead of it.
  const [maxRow] = await db
    .select({ maxId: sql<number | null>`max(${auditLog.id})` })
    .from(auditLog);
  const toId = maxRow?.maxId ?? 0;

  if (toId < fromId) {
    // No new rows since the last checkpoint — nothing to do, checkpoint
    // stays put.
    return { scanned: false };
  }

  const result = await verifyIntegrity(fromId, toId, {
    seedPrevHmac: checkpoint.lastVerifiedHmac,
  });

  if (result.totalChecked === 0) {
    // Defensive fallback for the same "nothing to verify" outcome — kept in
    // addition to the toId < fromId guard above in case totalChecked can
    // legitimately be 0 despite toId >= fromId (e.g. a race where rows in
    // [fromId, toId] were deleted between the snapshot and the scan).
    return { scanned: false };
  }

  // Determine the highest id actually scanned and its rowHmac from the real
  // rows in [fromId, toId], not via arithmetic on totalChecked: Postgres
  // serial sequences are NOT gapless (a rolled-back transaction consumes a
  // sequence value without leaving a row), so `fromId + totalChecked - 1`
  // can UNDERSTATE the true highest scanned id whenever a gap falls inside
  // the window. An understated scannedTo both under-reports compliance
  // evidence and, on the audit-write-failure fallback below, could seed the
  // next sweep's checkpoint with a non-existent id / null hmac — causing a
  // false chainBreak alarm on the next run instead of a clean resume.
  const [lastRow] = await db
    .select({ id: auditLog.id, rowHmac: auditLog.rowHmac })
    .from(auditLog)
    .where(and(gte(auditLog.id, fromId), lte(auditLog.id, toId)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  const scannedTo = lastRow?.id ?? toId;
  const lastVerifiedHmac = lastRow?.rowHmac ?? null;

  const status: "ok" | "violation" = result.valid ? "ok" : "violation";

  const cappedInvalidIds = result.invalidIds.slice(0, MAX_REPORTED_IDS);
  const cappedChainBreakIds = result.chainBreakIds.slice(0, MAX_REPORTED_IDS);
  // A sweep straddling a signing-secret rotation sees the pre-rotation rows
  // once — the checkpoint then moves past them, so this is the only sweep that
  // can report it. Recording it in the audit log itself is what makes the
  // rotation durable evidence, instead of a stderr line nobody reads (#599).
  const cappedPreviousKeyIds = result.previousKeyIds.slice(0, MAX_REPORTED_IDS);

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
      previousKeyCount: result.previousKeyIds.length,
      previousKeyIds: cappedPreviousKeyIds,
    },
  };
  // appendAuditLog inserts this audit.integrity_check row AND returns its
  // { id, rowHmac }. Fold that returned row into the checkpoint directly:
  // writing once, past the sweep's own report row, means the NEXT sweep starts
  // clean of its own prior report, so a "no activity since the last sweep"
  // steady state genuinely converges to a no-op instead of perpetually
  // rediscovering exactly one new row (its own last write) forever.
  //
  // Folding from the append's OWN return value — not a follow-up MAX(id) read —
  // is what makes this race-free: a separate "current highest row" query could
  // observe a row another request appended concurrently right after our report
  // and mis-fold THAT into the checkpoint, silently skipping the rows between
  // on the next sweep.
  //
  // Folding past the report is only safe when nothing else wrote while this
  // sweep was running. Rows another request appends between the toId snapshot
  // and the report land in (toId, reportId): outside this sweep's window
  // (> toId) AND below the next sweep's start (reportId + 1) — never verified
  // incrementally at all (#698). So probe that interval, and when it isn't
  // empty fold only to the window actually scanned: the next sweep re-scans
  // the raced rows together with this report row and converges again. One
  // extra non-converged sweep, paid only when concurrency really happened.
  //
  // Advancing even on violation is intentional: re-scanning the same tampered
  // window forever would just re-alarm on every cycle without surfacing new
  // information — the violation is recorded (audit row + stderr) exactly once.
  // On an audit-write failure there is no report row to fold, so fall back to
  // the window actually scanned.
  let ownRow: { id: number; rowHmac: string } | null = null;
  try {
    ownRow = await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }

  if (ownRow && !(await hasRowsBetween(toId, ownRow.id))) {
    await writeCheckpoint(ownRow.id, ownRow.rowHmac, status);
  } else {
    await writeCheckpoint(scannedTo, lastVerifiedHmac, status);
  }

  // A detected violation is observable in three places, all of them durable or
  // externally shipped: the audit.integrity_check failure row above, the
  // structured stderr line below, and the checkpoint's lastStatus. The
  // admin-authenticated GET /api/audit/verify/status (#699) reads the first and
  // third — deliberately with no process-local counter feeding it, since that
  // resets to 0 on restart and would silently clear the alarm. Equally
  // deliberate: none of this reaches the unauthenticated /api/health, which
  // would confirm to an attacker that their manipulation was noticed.
  if (!result.valid) {
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
    previousKeyCount: result.previousKeyIds.length,
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
