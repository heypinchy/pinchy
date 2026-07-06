import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapTestSchema } from "@/lib/schemas/imap";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { testImapLogin, testSmtpVerify, friendlyError } from "@/lib/integrations/imap-probe";

// Matches an email-shaped username so we can redact it the same way other
// audit fields redact identity data (see redactEmail() in @/lib/audit). Not
// every IMAP username is an email address, so this is a heuristic, not a
// validation rule.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = withAdmin(async (request: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(imapTestSchema, request);
  if ("error" in parsed) return parsed.error;

  const input = parsed.data;
  const actorId = session.user.id!;

  const identity = EMAIL_LIKE.test(input.username) ? redactEmail(input.username) : undefined;

  try {
    await testImapLogin(input);
    await testSmtpVerify(input);
  } catch (error) {
    const reason = friendlyError(error);

    try {
      await appendAuditLog({
        eventType: "integration.credentials_tested",
        actorType: "user",
        actorId,
        resource: "integration",
        outcome: "failure",
        error: { message: reason },
        detail: {
          imapHost: input.imapHost,
          smtpHost: input.smtpHost,
          reason,
          ...(identity ?? {}),
        },
      });
    } catch (auditErr) {
      recordAuditFailure(auditErr, {
        eventType: "integration.credentials_tested",
        actorType: "user",
        actorId,
        resource: "integration",
        outcome: "failure",
        error: { message: reason },
        detail: {
          imapHost: input.imapHost,
          smtpHost: input.smtpHost,
          reason,
          ...(identity ?? {}),
        },
      });
    }

    return NextResponse.json({ ok: false, error: reason }, { status: 400 });
  }

  try {
    await appendAuditLog({
      eventType: "integration.credentials_tested",
      actorType: "user",
      actorId,
      resource: "integration",
      outcome: "success",
      detail: {
        imapHost: input.imapHost,
        smtpHost: input.smtpHost,
        ...(identity ?? {}),
      },
    });
  } catch (auditErr) {
    recordAuditFailure(auditErr, {
      eventType: "integration.credentials_tested",
      actorType: "user",
      actorId,
      resource: "integration",
      outcome: "success",
      detail: {
        imapHost: input.imapHost,
        smtpHost: input.smtpHost,
        ...(identity ?? {}),
      },
    });
  }

  return NextResponse.json({ ok: true });
});
