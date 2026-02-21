import { createHmac } from "crypto";

export type AuditEventType =
  | "tool.execute"
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
