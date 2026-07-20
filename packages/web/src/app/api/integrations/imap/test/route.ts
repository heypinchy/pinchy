import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { imapTestSchema, type ImapTestResult, type ImapTestSuggestion } from "@/lib/schemas/imap";
import { appendAuditLog, redactEmail } from "@/lib/audit";
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
  if (isReachable(portProbe, 465) && failingPort === 587) {
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

  const auditDetail = {
    imapHost: input.imapHost,
    smtpHost: input.smtpHost,
    ...(imap.ok ? {} : { imapCode: imap.code }),
    ...(smtp.ok ? {} : { smtpCode: smtp.code }),
    ...(identity ?? {}),
  };

  const auditEntry = {
    eventType: "integration.credentials_tested" as const,
    actorType: "user" as const,
    actorId,
    resource: "integration",
    outcome: ok ? ("success" as const) : ("failure" as const),
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
