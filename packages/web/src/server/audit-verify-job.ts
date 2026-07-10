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
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
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
  // on the next sweep. (A smaller residual remains: rows appended DURING the
  // verify pass, in (toId, reportId), are caught by the full GET
  // /api/audit/verify scan but skipped by this incremental job — see #698.)
  //
  // Advancing even on violation is intentional: re-scanning the same tampered
  // window forever would just re-alarm on every cycle without surfacing new
  // information — the violation is recorded (audit row + stderr + counter)
  // exactly once. On an audit-write failure there is no report row to fold, so
  // fall back to the window actually scanned.
  try {
    const ownRow = await appendAuditLog(entry);
    await writeCheckpoint(ownRow.id, ownRow.rowHmac, status);
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
