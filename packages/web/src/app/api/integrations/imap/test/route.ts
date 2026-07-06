import { NextRequest, NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapTestSchema, type ImapTestInput } from "@/lib/schemas/imap";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

// Matches an email-shaped username so we can redact it the same way other
// audit fields redact identity data (see redactEmail() in @/lib/audit). Not
// every IMAP username is an email address, so this is a heuristic, not a
// validation rule.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maps low-level probe errors to short, friendly messages that never leak a
// stack trace or the password. Order matters: more specific patterns first.
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("auth") ||
    lower.includes("invalid login") ||
    lower.includes("invalid credentials") ||
    lower.includes("535")
  ) {
    return "Authentication failed — check the username and password";
  }
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("etimedout")) {
    return "Connection timed out — check the host and port";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("could not connect")
  ) {
    return "Could not connect to the server — check the host and port";
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("ssl")) {
    return "Could not establish a secure connection — check the security setting";
  }
  return "Connection failed — check your settings and try again";
}

async function testImapLogin(input: ImapTestInput): Promise<void> {
  const client = new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.security === "tls",
    auth: {
      user: input.username,
      pass: input.password,
    },
    logger: false,
  });
  await client.connect();
  await client.logout();
}

async function testSmtpVerify(input: ImapTestInput): Promise<void> {
  const transport = nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: input.security === "tls",
    requireTLS: input.security === "starttls",
    auth: {
      user: input.username,
      pass: input.password,
    },
  });
  try {
    await transport.verify();
  } finally {
    transport.close?.();
  }
}

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
