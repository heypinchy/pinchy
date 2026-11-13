import { redactEmail } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { buildInviteUrl } from "@/lib/invite-url";
import { classifyMailError } from "@/lib/system-mail/errors";
import { getOrgTimezone } from "@/lib/settings-timezone";
import type { EmailDelivery, SystemMailConfig } from "@/lib/schemas/system-mail";
import { getSystemMailConfig } from "@/lib/system-mail/config";
import { resolveLinkOrigin } from "@/lib/system-mail/link-origin";
import { buildLinkEmail, buildTestEmail, type EmailContent } from "@/lib/system-mail/templates";
import { sendSystemMail } from "@/lib/system-mail/transport";

/**
 * Sending an email on an admin's behalf, as one step that never throws.
 *
 * The callers have already created the invite (or reset token) by the time
 * this runs, and that must survive whatever SMTP does: a failure here comes
 * back as `{ sent: false, error }` for the dialog to show beside the link, so
 * an admin never has to recreate an invite because the mail server hiccupped.
 *
 * Every attempt writes one `mail.sent` row. `deferAuditLog`, because the email
 * is an outbound side effect that cannot be rolled back once sent.
 */

type MailPurpose = "invite" | "password_reset" | "test";

async function sendAndAudit(args: {
  config: SystemMailConfig;
  to: string;
  content: EmailContent;
  actorId: string;
  purpose: MailPurpose;
  inviteId?: string;
}): Promise<EmailDelivery> {
  const detail = {
    purpose: args.purpose,
    ...redactEmail(args.to),
    ...(args.inviteId ? { invite: { id: args.inviteId } } : {}),
  };
  try {
    await sendSystemMail(args.config, { to: args.to, ...args.content });
    deferAuditLog({
      actorType: "user",
      actorId: args.actorId,
      eventType: "mail.sent",
      detail,
      outcome: "success",
    });
    return { sent: true };
  } catch (error) {
    const message = classifyMailError(error);
    // The raw message usually quotes the recipient; log the classified one.
    console.error("[system-mail] send failed:", message);
    deferAuditLog({
      actorType: "user",
      actorId: args.actorId,
      eventType: "mail.sent",
      detail,
      outcome: "failure",
      error: { message },
    });
    return { sent: false, error: message };
  }
}

export async function deliverLinkEmail(input: {
  request: Request;
  kind: "invite" | "reset";
  to: string;
  token: string;
  expiresAt: Date;
  inviteId: string;
  actor: { id: string; name: string | null; email: string };
}): Promise<EmailDelivery> {
  const config = await getSystemMailConfig();
  if (!config) return { sent: false, error: "Email delivery isn't set up." };

  const origin = await resolveLinkOrigin(input.request);
  const content = buildLinkEmail({
    kind: input.kind,
    inviter: { name: input.actor.name, email: input.actor.email },
    instanceHost: new URL(origin).host,
    link: buildInviteUrl(origin, input.token),
    expiresAt: input.expiresAt,
    timeZone: await getOrgTimezone(),
  });

  return sendAndAudit({
    config,
    to: input.to,
    content,
    actorId: input.actor.id,
    purpose: input.kind === "invite" ? "invite" : "password_reset",
    inviteId: input.inviteId,
  });
}

export async function deliverTestEmail(input: {
  config: SystemMailConfig;
  request: Request;
  to: string;
  actorId: string;
}): Promise<EmailDelivery> {
  const origin = await resolveLinkOrigin(input.request);
  return sendAndAudit({
    config: input.config,
    to: input.to,
    content: buildTestEmail({ instanceHost: new URL(origin).host }),
    actorId: input.actorId,
    purpose: "test",
  });
}
