// Fetch audit log entries for a single chat session so a diagnostics bundle
// can show what the agent's tool calls did from the platform's point of view.
//
// v1 scope: rows whose `resource` column exactly matches the sessionKey. The
// chat path stamps the sessionKey on tool.* rows, so this is the simplest
// link between a session and its audit footprint. Future iterations may
// broaden the query (e.g. agent-scoped chat.* events that pre-date the
// session key field).
//
// We strip the HMAC + integrity fields before returning so they never leak
// into a downloadable bundle — they're useless outside the audit DB context
// and we want fewer secret-shaped bytes flying around in support archives.

import { asc, eq } from "drizzle-orm";
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

// `agentId` is accepted for future broadening (per-agent fallback queries) but
// currently unused — the sessionKey already encodes the agent.
export async function fetchAuditEntriesForSession(
  _agentId: string,
  sessionKey: string
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
    .where(eq(auditLog.resource, sessionKey))
    .orderBy(asc(auditLog.timestamp));

  return rows;
}
