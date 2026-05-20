// Fetch audit log entries for a single user's interactions with an agent so a
// diagnostics bundle can show what the agent's tool calls did from the
// platform's point of view.
//
// v1 scope: rows whose `resource` column matches `agent:<agentId>` AND whose
// `actorId` matches the requesting user. Every production code path
// (chat.send, tool.*, agent.* events) stamps `resource = "agent:<agentId>"` on
// audit rows — this is the canonical link between an audit row and an agent.
// Filtering on `actorId` ensures we never leak another user's audit rows into
// this user's diagnostics bundle.
//
// Time-range scoping is intentionally deferred: over-collecting is better than
// under-collecting for diagnostics, and the bundle size-cap trims aggressively
// when needed.
//
// We strip the HMAC + integrity fields before returning so they never leak
// into a downloadable bundle — they're useless outside the audit DB context
// and we want fewer secret-shaped bytes flying around in support archives.

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export interface CollectedAuditEntry {
  timestamp: Date;
  eventType: string;
  actorType: string;
  actorId: string;
  resource: string | null;
  detail: unknown;
  outcome: string | null;
  error: unknown;
}

export async function fetchAuditEntriesForSession(
  agentId: string,
  userId: string
): Promise<CollectedAuditEntry[]> {
  const rows = await db
    .select({
      timestamp: auditLog.timestamp,
      eventType: auditLog.eventType,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      resource: auditLog.resource,
      detail: auditLog.detail,
      outcome: auditLog.outcome,
      error: auditLog.error,
    })
    .from(auditLog)
    .where(and(eq(auditLog.resource, `agent:${agentId}`), eq(auditLog.actorId, userId)))
    .orderBy(asc(auditLog.timestamp));

  return rows;
}
