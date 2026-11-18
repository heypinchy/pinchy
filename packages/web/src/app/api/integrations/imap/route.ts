import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapCreateSchema } from "@/lib/schemas/imap";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { appendAuditLog, redactEmail, scrubEmails } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { assertMailHostAllowed, MailHostBlockedError } from "@/lib/integrations/mail-host-guard";

// Matches an email-shaped username so we can redact it the same way the IMAP
// test route does (see EMAIL_LIKE in imap/test/route.ts). Not every IMAP
// username is an email address, so this is a heuristic, not a validation rule.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Persists an IMAP/SMTP connection AFTER the client has already verified the
// credentials via POST /api/integrations/imap/test. We don't re-probe here —
// this route's job is only to encrypt-and-store what the client already
// confirmed works, then audit the creation.
//
// The one exception is the SSRF guard, which runs on BOTH routes. The test
// route's guard stops a one-shot probe of the internal network (pinchy#823);
// this one stops the durable version of the same thing, because nothing forces
// a client to call /test first, and a stored row is worse than a probe: the
// inbox sweep and the pinchy-email plugin reconnect to that host on a schedule
// and report what they find. It resolves DNS, so it is the only network call
// this route makes — a host that doesn't resolve is let through (see the
// guard), so a saveable connection never turns unsaveable on a DNS hiccup.
export const POST = withAdmin(async (request: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(imapCreateSchema, request);
  if ("error" in parsed) return parsed.error;

  const { name, imapHost, imapPort, smtpHost, smtpPort, username, password, security, senderName } =
    parsed.data;
  const actorId = session.user.id!;
  // `name` is an optional label for the integrations list; default it to the
  // mailbox address so the row always has a sensible, renameable name.
  const connectionName = name ?? username;

  const identity = EMAIL_LIKE.test(username) ? redactEmail(username) : undefined;

  try {
    await assertMailHostAllowed(imapHost);
    await assertMailHostAllowed(smtpHost);
  } catch (err) {
    if (!(err instanceof MailHostBlockedError)) throw err;

    // A refused host is security-relevant on its own — record the attempt, but
    // say only THAT a host was blocked. The guard's message already tells the
    // admin which tier they hit; naming the resolved address in an immutable
    // row would just archive someone's internal topology.
    const blockedEntry = {
      eventType: "integration.created" as const,
      actorType: "user" as const,
      actorId,
      resource: "integration",
      outcome: "failure" as const,
      error: { message: err.message },
      detail: {
        name: scrubEmails(connectionName),
        type: "imap",
        blocked: "host",
        ...(identity ?? {}),
      },
    };
    try {
      await appendAuditLog(blockedEntry);
    } catch (auditErr) {
      recordAuditFailure(auditErr, blockedEntry);
    }

    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  // Store every field (including host/port/security/senderName) encrypted as
  // a single blob — never persist the password (or the sender display name,
  // which is identity data) in plaintext anywhere, including `data`.
  const encryptedCredentials = encrypt(
    JSON.stringify({
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
      username,
      password,
      security,
      ...(senderName !== undefined ? { senderName } : {}),
    })
  );

  let connection;
  try {
    [connection] = await db
      .insert(integrationConnections)
      .values({
        type: "imap",
        name: connectionName,
        credentials: encryptedCredentials,
        // The client already tested these credentials via /imap/test before
        // calling this route, so the connection starts out active.
        status: "active",
        data: { emailAddress: username, provider: "imap" },
      })
      .returning();
  } catch (err) {
    const failureEntry = {
      eventType: "integration.created" as const,
      actorType: "user" as const,
      actorId,
      resource: "integration",
      outcome: "failure" as const,
      error: { message: err instanceof Error ? err.message : String(err) },
      // `connectionName` defaults to the mailbox address — scrub it so the
      // append-only audit row never stores the raw email (redacted identity
      // is spread separately below).
      detail: { name: scrubEmails(connectionName), type: "imap", ...(identity ?? {}) },
    };
    recordAuditFailure(err, failureEntry);
    return NextResponse.json({ error: "Could not create the IMAP connection" }, { status: 500 });
  }

  await appendAuditLog({
    eventType: "integration.created",
    actorType: "user",
    actorId,
    resource: `integration:${connection.id}`,
    outcome: "success",
    // The name defaults to the mailbox address; scrub it before it lands in
    // the append-only, HMAC-signed audit detail (GDPR Art. 17).
    detail: { id: connection.id, name: scrubEmails(connection.name), type: "imap" },
  });

  return NextResponse.json(
    {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      status: connection.status,
    },
    { status: 201 }
  );
});
