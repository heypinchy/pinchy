import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import {
  systemMailConfigSchema,
  type SystemMailConfig,
  type SystemMailStatus,
} from "@/lib/schemas/system-mail";
import {
  getSystemMailConfig,
  saveSystemMailConfig,
  deleteSystemMailConfig,
  mergeWithStoredPassword,
  needsPasswordReentry,
  toPublicConfig,
} from "@/lib/system-mail/config";
import { verifySystemMail } from "@/lib/system-mail/transport";
import { classifyMailError } from "@/lib/system-mail/errors";

/**
 * System mailer settings (Settings → Organization → Email delivery, #1309).
 * Off by default: no stored config means Pinchy sends no email and every
 * invite and reset link is shown for the admin to copy, exactly as before.
 */

const AUDITED_FIELDS = [
  "host",
  "port",
  "security",
  "username",
  "fromAddress",
  "fromName",
] as const satisfies ReadonlyArray<keyof SystemMailConfig>;

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * How a field's value appears in the audit row. The sender address and an
 * email-shaped username are personal data in an immutable, HMAC-chained row,
 * so they go in as `redactEmail()` (hash + masked preview), never verbatim —
 * the same rule the IMAP connection routes follow.
 */
function auditValue(field: string, value: unknown): unknown {
  if (typeof value === "string" && EMAIL_LIKE.test(value)) return redactEmail(value);
  // A login that isn't an address (an API-key user, a service account) is a
  // credential-adjacent identifier. The row says only that one is set; the
  // `from !== to` comparison still reports that it changed.
  if (field === "username" && typeof value === "string") return "(set)";
  return value ?? null;
}

type AuditedConfig = Pick<SystemMailConfig, (typeof AUDITED_FIELDS)[number]>;

/**
 * The audited fields only. The diff is built from this copy, never from the
 * config that carries the password, so no path leads from the secret to the
 * audit row (or to redactEmail's HMAC).
 */
function audited(config: SystemMailConfig | null): AuditedConfig | null {
  if (!config) return null;
  return {
    host: config.host,
    port: config.port,
    security: config.security,
    username: config.username,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
  };
}

/** Non-secret fields that differ, as `{ from, to }`. The password never appears. */
function diff(before: AuditedConfig | null, after: AuditedConfig | null) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of AUDITED_FIELDS) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (from !== to) changes[field] = { from: auditValue(field, from), to: auditValue(field, to) };
  }
  return changes;
}

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const config = await getSystemMailConfig();
  const status: SystemMailStatus = config
    ? { configured: true, config: toPublicConfig(config) }
    : { configured: false };
  return NextResponse.json(status);
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const parsed = await parseRequestBody(systemMailConfigSchema, request);
  if ("error" in parsed) return parsed.error;

  const stored = await getSystemMailConfig();
  if (needsPasswordReentry(parsed.data, stored)) {
    // Same shape as a schema refusal, so the form puts it under the field.
    return NextResponse.json(
      {
        error: "Validation failed",
        details: {
          formErrors: [],
          fieldErrors: {
            password: [
              "Enter the password again to switch to a less secure connection — Pinchy won't reuse the saved one.",
            ],
          },
        },
      },
      { status: 400 }
    );
  }
  const next = mergeWithStoredPassword(parsed.data, stored);
  const changes = diff(audited(stored), audited(next));
  const passwordChanged = (stored?.password ?? null) !== (next.password ?? null);

  // Verify before saving: nothing is persisted that hasn't proven it can
  // connect, negotiate TLS and log in. A failure is audited too — the host is
  // admin-supplied, and an attempt to reach an internal one should leave a trace.
  try {
    await verifySystemMail(next);
  } catch (error) {
    const message = classifyMailError(error);
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id,
      eventType: "settings.updated",
      resource: "settings:mail",
      detail: { changes, passwordChanged },
      outcome: "failure",
      error: { message },
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  await saveSystemMailConfig(next);
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: "settings.updated",
    resource: "settings:mail",
    detail: { changes, passwordChanged },
    outcome: "success",
  });

  const status: SystemMailStatus = { configured: true, config: toPublicConfig(next) };
  return NextResponse.json(status);
}

export async function DELETE() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const stored = await getSystemMailConfig();
  if (!stored) {
    // Nothing usable is stored. A row that can no longer be decrypted counts
    // as off too; saving a new config overwrites it, so it needs no delete.
    return NextResponse.json({ error: "Email delivery isn't set up." }, { status: 404 });
  }

  await deleteSystemMailConfig();
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: "settings.updated",
    resource: "settings:mail",
    detail: { changes: diff(audited(stored), null), passwordChanged: Boolean(stored.password) },
    outcome: "success",
  });

  const status: SystemMailStatus = { configured: false };
  return NextResponse.json(status);
}
