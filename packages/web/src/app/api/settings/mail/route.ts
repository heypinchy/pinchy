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
function auditValue(value: unknown): unknown {
  if (typeof value === "string" && EMAIL_LIKE.test(value)) return redactEmail(value);
  return value ?? null;
}

/** Non-secret fields that differ, as `{ from, to }`. The password never appears. */
function diff(before: SystemMailConfig | null, after: SystemMailConfig | null) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of AUDITED_FIELDS) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (from !== to) changes[field] = { from: auditValue(from), to: auditValue(to) };
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
  const next = mergeWithStoredPassword(parsed.data, stored);
  const changes = diff(stored, next);
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
    // A row that can't be read counts as off; remove it anyway so "Turn off"
    // always leaves nothing behind.
    await deleteSystemMailConfig();
    return NextResponse.json({ error: "Email delivery isn't set up." }, { status: 404 });
  }

  await deleteSystemMailConfig();
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: "settings.updated",
    resource: "settings:mail",
    detail: { changes: diff(stored, null), passwordChanged: Boolean(stored.password) },
    outcome: "success",
  });

  const status: SystemMailStatus = { configured: false };
  return NextResponse.json(status);
}
