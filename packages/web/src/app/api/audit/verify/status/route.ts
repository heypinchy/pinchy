/**
 * Admin-authenticated health surface for the periodic audit-chain verification
 * job (#699).
 *
 * Two deliberate constraints shape this route:
 *
 * 1. **Durable, not in-process.** The signal is read back out of
 *    `audit_verify_state` (written by every sweep) and `audit_log`, never from
 *    a process-local counter — a container restart must not silently clear a
 *    tamper alarm.
 *
 * 2. **Admin-only, never on /api/health.** The unauthenticated health endpoint
 *    is what the Docker healthcheck hits; publishing "tampering detected"
 *    there would confirm to an attacker that their manipulation was noticed.
 *
 * `lastStatus` describes the LAST sweep only: the job advances its checkpoint
 * past a tampered window on purpose (re-scanning it forever would just
 * re-alarm every cycle), so a later sweep over fresh, intact rows legitimately
 * writes "ok" again. That alone would let tamper evidence vanish from this
 * surface an hour after it appeared, so `lastViolationAt` reports the newest
 * `audit.integrity_check` failure row — append-only, never cleared — as the
 * answer to "has this log ever been found tampered with".
 */
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditVerifyState, auditLog } from "@/db/schema";
import { withAdmin } from "@/lib/api-auth";

const CHECKPOINT_ID = 1;

export interface AuditVerifyStatusResponse {
  /**
   * Outcome of the most recent sweep. `never_run` covers both "no checkpoint
   * row yet" and a row that has never recorded a status (the column is
   * nullable) — in neither case has a sweep result been persisted.
   */
  lastStatus: "ok" | "violation" | "never_run";
  /** Highest audit_log id the incremental job has verified. */
  lastVerifiedId: number;
  /**
   * When a sweep last ADVANCED the checkpoint — not a liveness signal. A sweep
   * that finds no rows appended since the last one returns without writing, so
   * on a quiet instance this legitimately sits hours behind the job's actual
   * last run. Read it as "verified up to here, at this time"; "is the job still
   * ticking?" needs alerting on the sweep itself (#262), not a staleness check
   * here.
   */
  lastRunAt: string | null;
  /** Timestamp of the newest recorded integrity violation, if any ever was. */
  lastViolationAt: string | null;
}

export const GET = withAdmin(async () => {
  const [checkpoint] = await db
    .select({
      lastVerifiedId: auditVerifyState.lastVerifiedId,
      lastStatus: auditVerifyState.lastStatus,
      updatedAt: auditVerifyState.updatedAt,
    })
    .from(auditVerifyState)
    .where(eq(auditVerifyState.id, CHECKPOINT_ID));

  const [violation] = await db
    .select({ timestamp: auditLog.timestamp })
    .from(auditLog)
    .where(and(eq(auditLog.eventType, "audit.integrity_check"), eq(auditLog.outcome, "failure")))
    .orderBy(desc(auditLog.timestamp))
    .limit(1);

  const lastStatus =
    checkpoint?.lastStatus === "ok" || checkpoint?.lastStatus === "violation"
      ? checkpoint.lastStatus
      : "never_run";

  const body: AuditVerifyStatusResponse = {
    lastStatus,
    lastVerifiedId: checkpoint?.lastVerifiedId ?? 0,
    lastRunAt: checkpoint?.updatedAt.toISOString() ?? null,
    lastViolationAt: violation?.timestamp.toISOString() ?? null,
  };

  return NextResponse.json(body);
});
