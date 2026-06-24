import { createHmac } from "crypto";
import { asc, desc, gte, lte, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, type AuditDetail } from "@/db/schema";
import { getOrCreateSecret } from "@/lib/encryption";

// Transaction-scoped advisory lock key that serializes audit appends so the
// prev-hash chain can never fork (two writers must not read the same
// predecessor). Arbitrary fixed constant, unique to the audit chain.
const AUDIT_CHAIN_LOCK_KEY = 738291002;

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

export type AuditResource =
  | "agent"
  | "group"
  | "user"
  | "settings"
  | "config"
  | "channel"
  | "chat"
  | "integration";

export type AuditEventType =
  | `tool.${string}`
  | "tool.denied"
  | "auth.login"
  | "auth.failed"
  | "auth.logout"
  | "auth.csrf_blocked"
  | "auth.password_reset_completed"
  | "auth.password_changed"
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "user.invited"
  | "user.invite_blocked"
  | "user.updated"
  | "user.deleted"
  | "config.changed"
  | "config.gated_config_removed"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "group.members_updated"
  | "user.groups_updated"
  | "user.role_updated"
  | "channel.created"
  | "channel.deleted"
  | "channel.degraded"
  | "channel.polling_failed"
  | "channel.recovered"
  | "chat.retry_triggered"
  | "chat.agent_error"
  | "chat.silent_stream"
  | "chat.run_timed_out"
  | "chat.run_no_first_chunk"
  | "chat.run_aborted"
  | "chat.run_completed_after_disconnect"
  | "chat.image_model_fallback"
  | "agent.model_unavailable"
  | "agent.memory_changed"
  | "agent.upstream_format_error"
  | "audit.exported"
  | "diagnostics.exported"
  | "integration.created"
  | "integration.updated"
  | "integration.deleted"
  | "integration.synced"
  | "integration.auth_failed"
  | "integration.auth_recovered"
  | "integration.credentials_updated"
  | "file.upload.staged"
  | "file.upload.attached"
  | "file.upload.expired";

interface HmacFieldsV1 {
  timestamp: Date;
  eventType: string;
  actorType: string;
  actorId: string;
  resource: string | null;
  detail: unknown;
}

interface HmacFieldsV2 extends HmacFieldsV1 {
  outcome: "success" | "failure";
  error: { message: string } | null;
}

interface HmacFieldsV3 extends HmacFieldsV2 {
  // rowHmac of the immediately-preceding audit row, or null for the genesis row.
  prevHmac: string | null;
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

// v3 = v2 + a hash-chain link. The payload keeps v2's positions 0-8 unchanged
// (with the version literal flipped to 3 for downgrade protection) and appends
// prevHmac at the END, per the VERSIONING.md recipe. Binding each row to its
// predecessor's hash makes deletion/reordering of rows tamper-evident.
export function computeRowHmacV3(secret: Buffer, fields: HmacFieldsV3): string {
  const payload = JSON.stringify([
    fields.timestamp.toISOString(),
    fields.eventType,
    fields.actorType,
    fields.actorId,
    fields.resource,
    sortKeys(fields.detail),
    3, // version — downgrade protection (see VERSIONING.md)
    fields.outcome,
    sortKeys(fields.error),
    fields.prevHmac, // v3 chain link, appended at END
  ]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Per-version HMAC functions used for both writing (appendAuditLog) and verifying
// (verifyIntegrity). v1 functions ignore v2-only fields by design — never delete
// or modify a version's function: see VERSIONING.md (added in a follow-up task).
export const ROW_HMAC_VERIFIERS: Record<
  number,
  (secret: Buffer, fields: HmacFieldsV1 | HmacFieldsV2 | HmacFieldsV3) => string
> = {
  1: (secret, fields) => computeRowHmacV1(secret, fields),
  2: (secret, fields) => computeRowHmacV2(secret, fields as HmacFieldsV2),
  3: (secret, fields) => computeRowHmacV3(secret, fields as HmacFieldsV3),
};

/**
 * GDPR redaction for email addresses going into audit `detail` payloads.
 *
 * The audit log is HMAC-signed and append-only — once an email lands in
 * detail, GDPR Art. 17 erasure conflicts with integrity. So we never
 * write the raw address. Instead we derive:
 *
 * - `emailHash`: keyed HMAC-SHA256 of the lowercased+trimmed email,
 *   so an admin holding a known address can match it against the log,
 *   but a leaked log on its own does not yield the addresses back.
 * - `emailPreview`: short masked form for human readability,
 *   `cl…lm@devcraft.academy` (first 2 + last 2 of local + domain).
 *
 * For very short local parts (≤4 chars) the masking would reveal more
 * than it hides, so we keep them intact.
 */
export type RedactedEmail = {
  emailHash: string;
  emailPreview: string;
};

export function redactEmail(email: string): RedactedEmail {
  const normalized = email.trim().toLowerCase();
  const secret = getOrCreateSecret("audit_hmac_secret");
  const emailHash = createHmac("sha256", secret).update(normalized).digest("hex");

  const atIndex = normalized.indexOf("@");
  if (atIndex === -1) {
    return { emailHash, emailPreview: normalized };
  }

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (local.length <= 4) {
    return { emailHash, emailPreview: `${local}@${domain}` };
  }

  return {
    emailHash,
    emailPreview: `${local.slice(0, 2)}…${local.slice(-2)}@${domain}`,
  };
}

/**
 * Defence-in-depth for free-text audit fields (e.g. `providerError` on
 * `chat.agent_error`). When an upstream provider validation error gets
 * echoed back — `"Invalid input: user@example.com is not …"` — we never
 * want the raw address to land in the append-only HMAC-signed audit
 * table: GDPR Art. 17 erasure on an HMAC-signed row is impossible by
 * design, so we substitute any email-shaped run with `<email-redacted>`.
 *
 * Distinct from `redactEmail`, which returns a structured
 * `{emailHash, emailPreview}` pair for fields where we KNOW an email
 * is identity data and may want to match it later. Here we operate on
 * opaque free text — the only goal is "don't store the raw address".
 *
 * The regex deliberately requires a TLD (`\.[A-Za-z]{2,}`) so social
 * `@handle` mentions in free text don't get mistaken for emails.
 */
// Unicode-aware: \p{L} covers internationalized-domain (IDN) emails like
// user@münchen.de, and the bracket alternative covers IP-literal domains like
// user@[192.168.1.1] — both of which the old ASCII-only class let through into
// the HMAC-signed, un-redactable audit detail. The TLD-required branch is kept
// so a social `@handle` mention isn't mistaken for an email.
const EMAIL_LIKE_PATTERN = /[\p{L}\p{N}._%+-]+@(?:\[[^\]\s]+\]|[\p{L}\p{N}.-]+\.[\p{L}]{2,})/gu;

export function scrubEmails(text: string): string {
  return text.replace(EMAIL_LIKE_PATTERN, "<email-redacted>");
}

/**
 * Canonical way to land an upstream `providerError` string in audit
 * detail. Single source of truth so every `providerError` field across
 * every audit event (chat.agent_error, agent.model_unavailable,
 * agent.upstream_format_error, chat.silent_stream, …) gets the same
 * scrub + truncate treatment without each call site rediscovering the
 * rules.
 *
 * - `scrubEmails` first, then truncate — never the other way round, so
 *   we don't accidentally slice in the middle of an email address and
 *   leave a partial `user@example` fragment behind.
 * - 1024-byte cap matches the existing limit on every providerError
 *   audit field; well under the 2048-byte AGENTS.md detail cap, which
 *   leaves headroom for surrounding detail fields.
 */
// Truncate a UTF-8 string to at most `maxBytes`, measuring and cutting in
// bytes (not UTF-16 code units). The cut backs up to the nearest UTF-8
// character boundary so a multi-byte sequence is never split — and so we never
// emit a replacement char, which would itself add bytes and overshoot the cap.
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // 0b10xxxxxx is a UTF-8 continuation byte; while we're on one, we're mid
  // character, so step back to the lead byte and drop the partial character.
  while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

const PROVIDER_ERROR_MAX_BYTES = 1024;
export function safeProviderError(text: string): string {
  return truncateUtf8(scrubEmails(text), PROVIDER_ERROR_MAX_BYTES);
}

const MAX_DETAIL_BYTES = 2048;

export function truncateDetail(detail: AuditDetail | null | undefined): AuditDetail | null {
  if (detail === null || detail === undefined) return null;
  const serialized = JSON.stringify(detail);
  // Measure in UTF-8 bytes — `.length` is UTF-16 code units, so multi-byte
  // content (CJK, emoji) could otherwise pass the cap while serializing to
  // 2-4x the byte size (AGENTS.md: "Keep audit detail under 2048 bytes").
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= MAX_DETAIL_BYTES) return detail;
  return {
    _truncated: true,
    _originalSize: byteLength,
    summary: truncateUtf8(serialized, MAX_DETAIL_BYTES - 100),
  };
}

type AuditLogBase = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  resource?: string | null;
  outcome: "success" | "failure";
  error?: { message: string } | null;
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
      eventType:
        | `${AuditResource}.created`
        | "user.invited"
        | "user.invite_blocked"
        | "config.changed"
        | "config.gated_config_removed";
      detail: Record<string, unknown>;
    })
  | (AuditLogBase & {
      eventType: `${AuditResource}.members_updated` | "user.groups_updated";
      detail: MembershipDetail;
    })
  | (AuditLogBase & {
      eventType: `auth.${string}`;
      detail?: Record<string, unknown>;
    })
  | (AuditLogBase & {
      eventType: `tool.${string}`;
      detail?: Record<string, unknown>;
    })
  | (AuditLogBase & {
      eventType: `chat.${string}`;
      detail?: Record<string, unknown>;
    })
  | (AuditLogBase & {
      // Channel-health watchdog (A-1/A-2/A-4): a channel poller (Telegram, …)
      // that crash-loops below the gateway WS — e.g. a cross-environment
      // getUpdates-409 conflict. `account.id` is the Pinchy agent id; the
      // conflict text in `lastError` is generic (no PII).
      eventType: "channel.degraded" | "channel.polling_failed" | "channel.recovered";
      detail: {
        channel: string;
        account: { id: string; name: string | null };
        lastError: string | null;
        reconnectAttempts: number;
        consecutiveDegradedChecks: number;
      };
    })
  | (AuditLogBase & {
      eventType: "agent.model_unavailable";
      detail: {
        agent: { id: string; name: string };
        model: string | null | undefined;
        providerError: string;
        ref?: string;
        httpStatus: number;
      };
    })
  | (AuditLogBase & {
      eventType: "agent.memory_changed";
      detail: {
        agent: { id: string; name: string };
        file: string;
        addedLines: number;
        removedLines: number;
        byteSize: number;
      };
    })
  | (AuditLogBase & {
      eventType: "agent.upstream_format_error";
      detail: {
        agent: { id: string; name: string };
        model: string | null | undefined;
        providerError: string;
        ref?: string;
        // Pattern family the error matched. Kept as `string` (rather than a
        // narrower literal union) so server-only commits can add a new known
        // pattern to the audit table — for frequency tracking — without a
        // schema migration. The chat-frame schema in `lib/schemas/chat-frames`
        // keeps the visible-to-UI set narrower (currently the single literal
        // `"thought_signature"`); extending the UI surface is a separate
        // commit that has to update both. Current values: "thought_signature".
        errorPattern: string;
      };
    })
  | (AuditLogBase & {
      eventType: "audit.exported";
      detail: { format: "csv" | "pdf"; filterSummary: string; rowCount: number };
    })
  | (AuditLogBase & {
      eventType: "diagnostics.exported";
      detail: {
        agent: { id: string; name: string };
        scope: {
          anchorTurnIndex: number | null;
          includedTurnRange: [number, number];
        };
        byteSize: number;
        droppedTurns: number;
        truncated: boolean;
      };
    })
  | (AuditLogBase & {
      eventType:
        | "integration.auth_failed"
        | "integration.auth_recovered"
        | "integration.credentials_updated"
        | "integration.synced";
      detail: {
        id: string;
        name: string;
        reason?: string;
        fields?: string[];
        modelCount?: number;
      };
    })
  | (AuditLogBase & {
      eventType: "file.upload.staged";
      detail:
        | {
            // success: file was stored and hashed
            uploadId: string;
            filename: string;
            mimeType: string;
            sizeBytes: number;
            contentHash: string;
            agent: EntityRef;
          }
        | {
            // failure: file was rejected before an uploadId was assigned
            filename: string;
            claimedMime: string;
            reason: string;
            agent: EntityRef;
          };
    })
  | (AuditLogBase & {
      eventType: "file.upload.attached";
      detail:
        | {
            // success: staged file materialised into a message
            uploadId: string;
            messageId: string;
            filename: string;
            agent: EntityRef;
          }
        | {
            // failure: cross-user, already-attached, or expired attachment attempt
            uploadId: string;
            reason: string;
          };
    })
  | (AuditLogBase & {
      eventType: "file.upload.expired";
      detail:
        | {
            // success: GC sweep deleted the orphaned staged file
            uploadId: string;
            filename: string;
            sizeBytes: number;
            /** Age of the file at sweep time, in seconds */
            agedSeconds: number;
            /** Correlates all files from a single GC run (OCSF metadata.correlation_uid) */
            sweepId: string;
          }
        | {
            // failure: GC sweep could not delete the orphaned staged file
            uploadId: string;
            filename: string;
            sweepId: string;
            reason: string;
          };
    });

export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  const secret = getOrCreateSecret("audit_hmac_secret");
  const timestamp = new Date();
  const detail = truncateDetail(entry.detail ?? null);
  const outcome = entry.outcome;
  const error = entry.error ?? null;

  // v3 hash-chain: each row binds the rowHmac of the immediately-preceding row.
  // The write runs inside a transaction holding an advisory lock so concurrent
  // appends are serialized — otherwise two writers could read the same
  // predecessor and fork the chain, which verifyIntegrity would (correctly) then
  // flag as tampering.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);

    const [prev] = await tx
      .select({ rowHmac: auditLog.rowHmac })
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(1);
    const prevHmac = prev?.rowHmac ?? null;

    const rowHmac = computeRowHmacV3(secret, {
      timestamp,
      eventType: entry.eventType,
      actorType: entry.actorType,
      actorId: entry.actorId,
      resource: entry.resource ?? null,
      detail,
      outcome,
      error,
      prevHmac,
    });

    await tx.insert(auditLog).values({
      timestamp,
      actorType: entry.actorType,
      actorId: entry.actorId,
      eventType: entry.eventType,
      resource: entry.resource ?? null,
      detail,
      version: 3,
      outcome,
      error,
      rowHmac,
      prevHmac,
    });
  });
}

interface VerifyResult {
  valid: boolean;
  totalChecked: number;
  invalidIds: number[];
  // v3 chain links that don't point at their predecessor's rowHmac — evidence
  // of a deleted (middle) row or a reordering, distinct from field tampering.
  chainBreakIds: number[];
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
  const chainBreakIds: number[] = [];
  // rowHmac of the previous row in range; undefined before the first row so the
  // first row in a partial range isn't chain-checked against a missing predecessor.
  let prevRowHmac: string | null | undefined = undefined;

  for (const entry of entries) {
    const verifier = ROW_HMAC_VERIFIERS[entry.version];
    if (!verifier) {
      invalidIds.push(entry.id);
      prevRowHmac = entry.rowHmac;
      continue;
    }

    const expectedHmac = verifier(secret, {
      timestamp: entry.timestamp,
      eventType: entry.eventType,
      actorType: entry.actorType,
      actorId: entry.actorId,
      resource: entry.resource,
      detail: entry.detail,
      outcome: (entry.outcome ?? "success") as "success" | "failure",
      error: entry.error as { message: string } | null,
      prevHmac: entry.prevHmac, // v3 verifier uses this; v1/v2 ignore it
    });

    if (expectedHmac !== entry.rowHmac) {
      invalidIds.push(entry.id);
    } else if (entry.version >= 3 && prevRowHmac !== undefined && entry.prevHmac !== prevRowHmac) {
      // The row's own HMAC is intact, but its chain link no longer matches the
      // preceding row — a row between them was deleted, or the rows were
      // reordered. The per-row HMAC alone can't catch this.
      chainBreakIds.push(entry.id);
    }

    prevRowHmac = entry.rowHmac;
  }

  return {
    valid: invalidIds.length === 0 && chainBreakIds.length === 0,
    totalChecked: entries.length,
    invalidIds,
    chainBreakIds,
  };
}
