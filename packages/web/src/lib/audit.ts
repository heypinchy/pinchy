import { createHmac } from "crypto";
import { asc, gte, lte, and } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { getOrCreateSecret } from "@/lib/encryption";

// ── Audit Detail Base Types ─────────────────────────────────────────────

export type EntityRef = { id: string; name: string };

export type UpdateDetail = {
  changes: Record<string, { from: unknown; to: unknown }>;
  [key: string]: unknown;
};

export type DeleteDetail = { name: string; [key: string]: unknown };

export type MembershipDetail = {
  added: EntityRef[];
  removed: EntityRef[];
  memberCount: number;
  [key: string]: unknown;
};

export type AuditResource = "agent" | "group" | "user" | "settings" | "config" | "channel";

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
  | "config.changed"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "group.members_updated"
  | "user.groups_updated"
  | "user.role_updated"
  | "channel.created"
  | "channel.deleted";

interface HmacFields {
  timestamp: Date;
  eventType: string;
  actorType: string;
  actorId: string;
  resource: string | null;
  detail: unknown;
}

/**
 * Recursively sort object keys to produce a canonical JSON representation.
 * PostgreSQL JSONB reorders keys (by length, then alphabetically), so without
 * canonical sorting the HMAC computed at insert time (JS key order) would
 * differ from the HMAC recomputed after a DB round-trip (JSONB key order).
 */
export function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function computeRowHmac(secret: Buffer, fields: HmacFields): string {
  const payload = JSON.stringify([
    fields.timestamp.toISOString(),
    fields.eventType,
    fields.actorType,
    fields.actorId,
    fields.resource,
    sortKeys(fields.detail),
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

type AuditLogBase = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  resource?: string | null;
};

export type AuditLogEntry =
  | (AuditLogBase & {
      eventType: `${AuditResource}.updated` | "user.role_updated";
      detail: UpdateDetail;
    })
  | (AuditLogBase & {
      eventType: `${AuditResource}.deleted`;
      detail: DeleteDetail;
    })
  | (AuditLogBase & {
      eventType: `${AuditResource}.created` | "user.invited" | "config.changed";
      detail: Record<string, unknown>;
    })
  | (AuditLogBase & {
      eventType: `${AuditResource}.members_updated` | "user.groups_updated";
      detail: MembershipDetail;
    })
  | (AuditLogBase & {
      eventType: `auth.${string}` | `tool.${string}`;
      detail?: Record<string, unknown>;
    });

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
