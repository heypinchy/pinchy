import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapCreateSchema } from "@/lib/schemas/imap";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

// Matches an email-shaped username so we can redact it the same way the IMAP
// test route does (see EMAIL_LIKE in imap/test/route.ts). Not every IMAP
// username is an email address, so this is a heuristic, not a validation rule.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Persists an IMAP/SMTP connection AFTER the client has already verified the
// credentials via POST /api/integrations/imap/test. We don't re-probe here —
// this route's job is only to encrypt-and-store what the client already
// confirmed works, then audit the creation.
export const POST = withAdmin(async (request: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(imapCreateSchema, request);
  if ("error" in parsed) return parsed.error;

  const { name, imapHost, imapPort, smtpHost, smtpPort, username, password, security, senderName } =
    parsed.data;
  const actorId = session.user.id!;
  // `name` is an optional label for the integrations list; default it to the
  // mailbox address so the row always has a sensible, renameable name.
  const connectionName = name ?? username;

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
    const identity = EMAIL_LIKE.test(username) ? redactEmail(username) : undefined;
    const failureEntry = {
      eventType: "integration.created" as const,
      actorType: "user" as const,
      actorId,
      resource: "integration",
      outcome: "failure" as const,
      error: { message: err instanceof Error ? err.message : String(err) },
      detail: { name: connectionName, type: "imap", ...(identity ?? {}) },
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
    detail: { id: connection.id, name: connection.name, type: "imap" },
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
