import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog, redactEmail } from "@/lib/audit";
import { getLicenseStatus } from "@/lib/enterprise";
import { getSeatUsage } from "@/lib/seat-usage";
import { evaluateSeatPressure } from "@/lib/seat-grace";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { parseRequestBody } from "@/lib/api-validation";
import { inviteUserSchema } from "@/lib/schemas/users";
import type { EmailDelivery } from "@/lib/schemas/system-mail";
import { deliverLinkEmail } from "@/lib/system-mail/deliver";

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const parsed = await parseRequestBody(inviteUserSchema, request);
  if ("error" in parsed) return parsed.error;
  const { email, role, groupIds, sendEmail } = parsed.data;

  const license = await getLicenseStatus();
  if (license.active && license.maxUsers > 0) {
    const usage = await getSeatUsage(license);
    // Soft cap with a 20% grace window (pricing concept § 5): invites keep
    // working up to floor(1.2 * maxUsers) seats so a new hire never waits on
    // procurement. Existing users are never deactivated or degraded.
    const pressure = evaluateSeatPressure(usage.used, license.maxUsers);
    if (!pressure.inviteAllowed) {
      after(() =>
        appendAuditLog({
          actorType: "user",
          actorId: session.user.id!,
          eventType: "user.invite_blocked",
          detail: {
            ...redactEmail(email),
            role,
            reason: "seat_cap",
            seatsUsed: usage.used,
            maxUsers: license.maxUsers,
            graceCap: pressure.graceCap,
          },
          outcome: "failure",
          error: { message: "Seat cap reached" },
        })
      );
      return NextResponse.json(
        {
          error: "Seat limit reached",
          message: `Your license includes ${license.maxUsers} seats with grace up to ${pressure.graceCap}. Remove an existing user or pending invitation, or email sales@heypinchy.com for a quote you can accept online.`,
          seatsUsed: usage.used,
          maxUsers: license.maxUsers,
          graceCap: pressure.graceCap,
        },
        { status: 403 }
      );
    }
  }

  const invite = await createInvite({ email, role, createdBy: session.user.id, groupIds });

  let auditGroups: Array<{ id: string; name: string }> = [];
  if (groupIds && groupIds.length > 0) {
    const groupRows = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(inArray(groups.id, groupIds));
    const nameMap = new Map(groupRows.map((g: { id: string; name: string }) => [g.id, g.name]));
    auditGroups = groupIds.map((id: string) => ({ id, name: nameMap.get(id) ?? id }));
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.invited",
      detail: {
        ...redactEmail(email),
        role,
        ...(auditGroups.length > 0 ? { groups: auditGroups } : {}),
      },
      outcome: "success",
    })
  );

  // The invite exists from here on. Emailing it is a second, separate step:
  // whatever the mail server does, the response still carries the token so
  // the admin can copy the link (#1309).
  let emailDelivery: EmailDelivery | undefined;
  if (sendEmail) {
    emailDelivery = await deliverLinkEmail({
      request,
      kind: "invite",
      to: email,
      token: invite.token,
      expiresAt: invite.expiresAt,
      inviteId: invite.id,
      actor: { id: session.user.id, name: session.user.name, email: session.user.email },
    }).catch((err: unknown): EmailDelivery => {
      console.error("[invite] email delivery crashed:", err);
      return { sent: false, error: "Something went wrong sending the email." };
    });
  }

  return NextResponse.json(emailDelivery ? { ...invite, emailDelivery } : invite, { status: 201 });
}
