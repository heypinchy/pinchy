import { after } from "next/server";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";

// Process-wide counter for audit-log writes that failed inside a deferred
// after() callback or via recordAuditFailure(). Exposed so health/metrics
// endpoints (or alerts) can surface the gap — silent .catch(console.error)
// is exactly what #231 forbids.
//
// Note: this is per-process state. Pinchy's Docker Compose deployment runs
// a single Node process, so the counter is authoritative for the running
// container. If we ever scale to multiple workers (Node cluster, multiple
// containers), aggregation must happen in an external metric store.
let writeFailedCount = 0;

export function getAuditWriteFailedCount(): number {
  return writeFailedCount;
}

export function resetAuditWriteFailedCount(): void {
  writeFailedCount = 0;
}

/**
 * Record an audit-log write failure as a structured signal.
 *
 * Increments the process-wide failure counter and emits a single JSON line
 * to stderr with `event: "audit_log_write_failed"` so log shipping /
 * alerting can hook into it. Use this anywhere an audit-log call must not
 * throw upward (e.g. WebSocket message handlers where a chat retry should
 * not fail just because the audit row didn't make it).
 */
export function recordAuditFailure(err: unknown, entry: AuditLogEntry): void {
  writeFailedCount++;
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      level: "error",
      event: "audit_log_write_failed",
      eventType: entry.eventType,
      actorType: entry.actorType,
      actorId: entry.actorId,
      resource: entry.resource ?? null,
      outcome: entry.outcome,
      error: { message },
    })
  );
}

/**
 * Schedule an audit-log write to run after the response is sent.
 *
 * REQUEST SCOPE ONLY. `after()` from `next/server` throws "called outside a
 * request scope" when invoked from a WebSocket handler, cron job, or
 * module-load code. Use `appendAuditLog()` directly + `recordAuditFailure()`
 * in those contexts.
 *
 * Use only when the action's side effect cannot be rolled back if the audit
 * write fails (OAuth token persisted, integration row already created, etc.).
 * For idempotent state changes prefer `await appendAuditLog(...)` inside the
 * handler so a failure surfaces as a 500.
 *
 * On failure: increments the failure counter and emits a structured JSON
 * line via `recordAuditFailure()`. Never throws.
 */
export function deferAuditLog(entry: AuditLogEntry): void {
  after(async () => {
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  });
}
