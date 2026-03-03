import { createHmac } from "crypto";
import { asc, gte, lte, and } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { getOrCreateSecret } from "@/lib/encryption";

export type AuditEventType =
  | `tool.${string}`
  | "tool.denied"
  | "auth.login"
  | "auth.failed"
  | "auth.logout"
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "user.invited"
  | "user.updated"
  | "user.deleted"
  | "config.changed";

interface HmacFields {
  timestamp: Date;
  eventType: string;
  actorType: string;
  actorId: string;
  resource: string | null;
  detail: unknown;
}

export function computeRowHmac(secret: Buffer, fields: HmacFields): string {
  const payload = JSON.stringify([
    fields.timestamp.toISOString(),
    fields.eventType,
    fields.actorType,
    fields.actorId,
    fields.resource,
    fields.detail,
  ]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

const MAX_DETAIL_BYTES = 2048;

export function truncateDetail(detail: unknown): unknown {
  if (detail === null || detail === undefined) return null;
  const serialized = JSON.stringify(detail);
  if (serialized.length <= MAX_DETAIL_BYTES) return detail;
  return {
    _truncated: true,
    _originalSize: serialized.length,
    summary: serialized.slice(0, MAX_DETAIL_BYTES - 100),
  };
}

interface AuditLogEntry {
  actorType: "user" | "agent" | "system";
  actorId: string;
  eventType: AuditEventType;
  resource?: string | null;
  detail?: unknown;
}

export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  const secret = getOrCreateSecret("audit_hmac_secret");
  const timestamp = new Date();
  const detail = truncateDetail(entry.detail ?? null);

  const rowHmac = computeRowHmac(secret, {
    timestamp,
    eventType: entry.eventType,
    actorType: entry.actorType,
    actorId: entry.actorId,
    resource: entry.resource ?? null,
    detail,
  });

  await db.insert(auditLog).values({
    timestamp,
    actorType: entry.actorType,
    actorId: entry.actorId,
    eventType: entry.eventType,
    resource: entry.resource ?? null,
    detail,
    rowHmac,
  });
}

interface VerifyResult {
  valid: boolean;
  totalChecked: number;
  invalidIds: number[];
}

export async function verifyIntegrity(fromId?: number, toId?: number): Promise<VerifyResult> {
  const secret = getOrCreateSecret("audit_hmac_secret");

  const conditions = [];
  if (fromId !== undefined) conditions.push(gte(auditLog.id, fromId));
  if (toId !== undefined) conditions.push(lte(auditLog.id, toId));

  const entries = await db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(auditLog.id));

  const invalidIds: number[] = [];

  for (const entry of entries) {
    const expectedHmac = computeRowHmac(secret, {
      timestamp: entry.timestamp,
      eventType: entry.eventType,
      actorType: entry.actorType,
      actorId: entry.actorId,
      resource: entry.resource,
      detail: entry.detail,
    });

    if (expectedHmac !== entry.rowHmac) {
      invalidIds.push(entry.id);
    }
  }

  return {
    valid: invalidIds.length === 0,
    totalChecked: entries.length,
    invalidIds,
  };
}
