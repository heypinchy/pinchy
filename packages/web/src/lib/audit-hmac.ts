import { createHmac } from "crypto";

// ── Audit row integrity signing ─────────────────────────────────────────────
//
// The trust-critical primitives behind the append-only, tamper-evident audit
// log. Extracted from audit.ts so every byte that goes into a row HMAC — and
// every version of the signing scheme — lives in one focused, auditable place,
// separate from the DB-append and redaction logic that consume them.

export interface HmacFieldsV1 {
  timestamp: Date;
  eventType: string;
  actorType: string;
  actorId: string;
  resource: string | null;
  detail: unknown;
}

export interface HmacFieldsV2 extends HmacFieldsV1 {
  outcome: "success" | "failure";
  error: { message: string } | null;
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

export function computeRowHmacV1(secret: Buffer, fields: HmacFieldsV1): string {
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

export function computeRowHmacV2(secret: Buffer, fields: HmacFieldsV2): string {
  const payload = JSON.stringify([
    fields.timestamp.toISOString(),
    fields.eventType,
    fields.actorType,
    fields.actorId,
    fields.resource,
    sortKeys(fields.detail),
    2, // version — downgrade protection (see VERSIONING.md)
    fields.outcome,
    sortKeys(fields.error),
  ]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Per-version HMAC functions used for both writing (appendAuditLog) and verifying
// (verifyIntegrity). v1 functions ignore v2-only fields by design — never delete
// or modify a version's function: see VERSIONING.md (added in a follow-up task).
export const ROW_HMAC_VERIFIERS: Record<
  number,
  (secret: Buffer, fields: HmacFieldsV1 | HmacFieldsV2) => string
> = {
  1: (secret, fields) => computeRowHmacV1(secret, fields),
  2: (secret, fields) => computeRowHmacV2(secret, fields as HmacFieldsV2),
};
