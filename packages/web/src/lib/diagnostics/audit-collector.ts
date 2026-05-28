// Fetch audit log entries for a single user's interactions with an agent so a
// diagnostics bundle can show what the agent's tool calls did from the
// platform's point of view.
//
// Filter:
//   - `resource = "agent:<agentId>"` — every production code path (chat.send,
//     tool.*, agent.* events) stamps this; canonical link to the agent.
//   - `actorId = userId` — one user's bundle never leaks another user's
//     audit rows for the same agent.
//   - optional `[from, to]` time range, inclusive — scoped to the selected
//     turn window so the bundle's audit section reflects the same time
//     period as the conversation turns it accompanies, rather than the
//     entire history of the agent.
//
// We strip the HMAC + integrity fields before returning so they never leak
// into a downloadable bundle — they're useless outside the audit DB context
// and we want fewer secret-shaped bytes flying around in support archives.

import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
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

export interface AuditQueryRange {
  from: Date;
  to: Date;
}

export async function fetchAuditEntriesForSession(
  agentId: string,
  userId: string,
  range?: AuditQueryRange
): Promise<CollectedAuditEntry[]> {
  const conditions: SQL[] = [
    eq(auditLog.resource, `agent:${agentId}`),
    eq(auditLog.actorId, userId),
  ];
  if (range) {
    conditions.push(gte(auditLog.timestamp, range.from));
    conditions.push(lte(auditLog.timestamp, range.to));
  }
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
    .where(and(...conditions))
    .orderBy(asc(auditLog.timestamp));

  return rows;
}
