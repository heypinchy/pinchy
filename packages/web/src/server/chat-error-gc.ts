/**
 * Retention sweep for the durable chat-error store. Rows are tiny (one per agent
 * error), but resolved ones — superseded by a later success or dismissed by the
 * user — accumulate forever otherwise. Un-resolved rows are the live banner
 * state and are NEVER swept regardless of age.
 *
 * Mirrors `upload-gc.ts`: an hourly interval plus a post-startup kick, and a
 * single `sweepId` UUID per run on the summary audit row so an analyst can
 * correlate the sweep (AGENTS.md §"Audit logging rules").
 */
import { and, lt, or, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { chatSessionErrors } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface ChatErrorSweepResult {
  swept: number;
  sweepId: string;
}

export async function sweepResolvedChatErrors(): Promise<ChatErrorSweepResult> {
  const sweepId = crypto.randomUUID();
  const cutoff = new Date(Date.now() - RETENTION_MS);

  const deleted = await db
    .delete(chatSessionErrors)
    .where(
      and(
        lt(chatSessionErrors.createdAt, cutoff),
        or(isNotNull(chatSessionErrors.supersededAt), isNotNull(chatSessionErrors.dismissedAt))
      )
    )
    .returning({ id: chatSessionErrors.id });

  const swept = deleted.length;
  if (swept > 0) {
    // Summary row (not per-deleted-row) — these are bulk housekeeping deletes.
    const entry = {
      eventType: "chat.error_gc" as const,
      actorType: "system" as const,
      actorId: "chat-error-gc",
      outcome: "success" as const,
      detail: { swept, retentionDays: RETENTION_DAYS, sweepId },
    };
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }

  return { swept, sweepId };
}

const GC_INTERVAL_MS = 60 * 60 * 1000;

let _gcInterval: ReturnType<typeof setInterval> | null = null;
let _gcStartupTimeout: ReturnType<typeof setTimeout> | null = null;

export function startChatErrorGc(): void {
  _gcInterval = setInterval(() => {
    sweepResolvedChatErrors().catch((err) => console.error("[chat-error-gc] sweep failed:", err));
  }, GC_INTERVAL_MS);

  _gcStartupTimeout = setTimeout(() => {
    _gcStartupTimeout = null;
    sweepResolvedChatErrors().catch((err) => console.error("[chat-error-gc] sweep failed:", err));
  }, 30_000);
}

export function stopChatErrorGc(): void {
  if (_gcInterval !== null) {
    clearInterval(_gcInterval);
    _gcInterval = null;
  }
  if (_gcStartupTimeout !== null) {
    clearTimeout(_gcStartupTimeout);
    _gcStartupTimeout = null;
  }
}

// Test-only helper (mirrors upload-gc / usage-poller pattern).
export function _isChatErrorGcRunning(): boolean {
  return _gcInterval !== null;
}
