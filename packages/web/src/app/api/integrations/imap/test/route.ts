import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapTestSchema, type ImapTestResult, type ImapTestSuggestion } from "@/lib/schemas/imap";
import { appendAuditLog, redactEmail, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import {
  testImapLogin,
  testSmtpVerify,
  classifyProbeError,
  probeSmtpPorts,
  type LegResult,
  type SmtpPortProbe,
} from "@/lib/integrations/imap-probe";

// Matches an email-shaped username so we can redact it the same way other
// audit fields redact identity data (see redactEmail() in @/lib/audit). Not
// every IMAP username is an email address, so this is a heuristic, not a
// validation rule.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The detail shape this route is contractually allowed to write, taken from the
// audit union itself so the two cannot drift apart.
type CredentialsTestedDetail = Extract<
  AuditLogEntry,
  { eventType: "integration.credentials_tested" }
>["detail"];

// Both legs are always run — a firewalled SMTP port is exactly the diagnostic
// this endpoint exists to surface, so a failed IMAP login must not hide it.
async function runLeg(fn: () => Promise<void>): Promise<LegResult> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    const { code, message } = classifyProbeError(error);
    return { ok: false, code, message };
  }
}

function isReachable(portProbe: SmtpPortProbe[], port: number): boolean {
  return portProbe.find((p) => p.port === port)?.reachable ?? false;
}

// Only ever suggests 465/587 (the two ports probeSmtpPorts checks alongside
// 25) — never a port derived from anything beyond the fixed reachability
// probe result.
function buildSuggestion(failingPort: number, portProbe: SmtpPortProbe[]): ImapTestSuggestion {
  if (isReachable(portProbe, 587) && failingPort !== 587) {
    return { kind: "switch_smtp_port", port: 587, security: "starttls" };
  }
  if (isReachable(portProbe, 465) && failingPort !== 465) {
    return { kind: "switch_smtp_port", port: 465, security: "tls" };
  }
  if (!isReachable(portProbe, 465) && !isReachable(portProbe, 587)) {
    return { kind: "all_smtp_blocked" };
  }
  return null;
}

export const POST = withAdmin(async (request: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(imapTestSchema, request);
  if ("error" in parsed) return parsed.error;

  const input = parsed.data;
  const actorId = session.user.id!;

  const identity = EMAIL_LIKE.test(input.username) ? redactEmail(input.username) : undefined;

  const imap = await runLeg(() => testImapLogin(input));
  const smtp = await runLeg(() => testSmtpVerify(input));

  let smtpPortProbe: SmtpPortProbe[] | undefined;
  let suggestion: ImapTestSuggestion | undefined;
  if (!smtp.ok && (smtp.code === "timeout" || smtp.code === "refused")) {
    smtpPortProbe = await probeSmtpPorts(input.smtpHost);
    suggestion = buildSuggestion(input.smtpPort, smtpPortProbe);
  }

  const ok = imap.ok && smtp.ok;
  // IMAP takes priority as the primary banner message: a broken IMAP login
  // blocks reading mail entirely, which is more severe than an SMTP-only
  // (send-side) problem.
  const error = !imap.ok ? imap.message : !smtp.ok ? smtp.message : undefined;

  const result: ImapTestResult = {
    ok,
    imap,
    smtp,
    ...(smtpPortProbe ? { smtpPortProbe } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(error ? { error } : {}),
  };

  // Annotated, not inferred. An inferred local passed to appendAuditLog skips
  // TypeScript's excess-property check, which is how `imapCode`/`smtpCode` came
  // to be written while the AuditLogEntry union still advertised a `reason`
  // nothing wrote. The annotation has to sit HERE rather than on
  // `auditEntry` below: excess-property checking only applies to an object
  // LITERAL being assigned, so `detail: auditDetail` re-opens the hole the
  // moment the detail is built as a variable.
  const auditDetail: CredentialsTestedDetail = {
    imapHost: input.imapHost,
    smtpHost: input.smtpHost,
    // Direct properties, NOT conditional spreads. A spread is invisible to
    // excess-property checking (verified with a canary), so `...(imap.ok ? {} :
    // { imapCode: imap.code })` would keep exactly the hole the annotation
    // above exists to close. `undefined` disappears on JSON serialization, so
    // the stored row is byte-identical to the spread version.
    imapCode: imap.ok ? undefined : imap.code,
    smtpCode: smtp.ok ? undefined : smtp.code,
    // Still a spread, and still unchecked — but `identity` is a typed
    // RedactedEmail, so its shape is pinned by redactEmail()'s return type
    // rather than by this assignment.
    ...(identity ?? {}),
  };

  const auditEntry: AuditLogEntry = {
    eventType: "integration.credentials_tested",
    actorType: "user",
    actorId,
    resource: "integration",
    outcome: ok ? "success" : "failure",
    ...(ok ? {} : { error: { message: error ?? "Connection test failed" } }),
    detail: auditDetail,
  };

  try {
    await appendAuditLog(auditEntry);
  } catch (auditErr) {
    recordAuditFailure(auditErr, auditEntry);
  }

  return NextResponse.json(result);
});
