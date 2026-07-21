/**
 * Expiry + retention sweep for tool-call confirmations (#124 Tier 2).
 *
 * Two passes on the chat-error-gc cadence (hourly interval + post-startup
 * kick):
 *
 *   1. Flip overdue `pending` rows to `expired`. The gate, the inbox listing
 *      and the decision route all check `expires_at` themselves (fail-closed),
 *      so this is bookkeeping — but it is what makes the `approval.expired`
 *      audit event real and keeps the operational table honest. One audit row
 *      per request (the trail carries each request's full lifecycle), all
 *      sharing one `sweepId` per run (AGENTS.md §"Audit logging rules").
 *
 *   2. Delete settled rows (`consumed`/`denied`/`expired`, plus dead
 *      `approved` grants that were never consumed) past the retention window,
 *      with a single summary `approval.gc` audit row — bulk housekeeping,
 *      the per-request history already lives in the audit trail.
 */
import { and, inArray, lt } from "drizzle-orm";

import { db } from "@/db";
import { agents, toolApproval, users } from "@/db/schema";
import { expireStale, type ExpiredApproval } from "@/lib/approvals/service";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

export const TERMINAL_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ApprovalSweepResult {
  expired: number;
  deleted: number;
  sweepId: string;
}

async function auditExpired(rows: ExpiredApproval[], sweepId: string): Promise<void> {
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, [...new Set(rows.map((r) => r.agentId))]));
  const agentNames = new Map(agentRows.map((r) => [r.id, r.name]));
  const userRows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(rows.map((r) => r.requesterId))]));
  const userNames = new Map(userRows.map((r) => [r.id, r.name]));
  for (const row of rows) {
    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "approval-sweep",
      eventType: "approval.expired",
      resource: `approval:${row.id}`,
      outcome: "success",
      detail: {
        request: { id: row.id },
        agent: { id: row.agentId, name: agentNames.get(row.agentId) ?? null },
        requester: { id: row.requesterId, name: userNames.get(row.requesterId) ?? null },
        toolName: row.toolName,
        argsDigest: row.argsDigest,
        sweepId,
      },
    };
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }
}

export async function sweepApprovals(now = new Date()): Promise<ApprovalSweepResult> {
  const sweepId = crypto.randomUUID();

  const expiredRows = await expireStale(now);
  if (expiredRows.length > 0) {
    await auditExpired(expiredRows, sweepId);
  }

  const cutoff = new Date(now.getTime() - TERMINAL_RETENTION_DAYS * DAY_MS);
  const deleted = await db
    .delete(toolApproval)
    .where(
      and(
        // Never delete `pending`: pass 1 flips anything overdue, so an old
        // pending row can only mean a deliberately long TTL still in flight.
        inArray(toolApproval.status, ["consumed", "denied", "expired", "approved"]),
        lt(toolApproval.createdAt, cutoff)
      )
    )
    .returning({ id: toolApproval.id });
  if (deleted.length > 0) {
    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "approval-sweep",
      eventType: "approval.gc",
      outcome: "success",
      detail: {
        swept: deleted.length,
        retentionDays: TERMINAL_RETENTION_DAYS,
        sweepId,
      },
    };
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }

  return { expired: expiredRows.length, deleted: deleted.length, sweepId };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let _interval: ReturnType<typeof setInterval> | null = null;
let _startupTimeout: ReturnType<typeof setTimeout> | null = null;

export function startApprovalSweep(): void {
  _interval = setInterval(() => {
    sweepApprovals().catch((err) => console.error("[approval-sweep] sweep failed:", err));
  }, SWEEP_INTERVAL_MS);

  _startupTimeout = setTimeout(() => {
    _startupTimeout = null;
    sweepApprovals().catch((err) => console.error("[approval-sweep] sweep failed:", err));
  }, 30_000);
}

export function stopApprovalSweep(): void {
  if (_interval !== null) {
    clearInterval(_interval);
    _interval = null;
  }
  if (_startupTimeout !== null) {
    clearTimeout(_startupTimeout);
    _startupTimeout = null;
  }
}

// Test-only helper (mirrors chat-error-gc / upload-gc pattern).
export function _isApprovalSweepRunning(): boolean {
  return _interval !== null;
}
