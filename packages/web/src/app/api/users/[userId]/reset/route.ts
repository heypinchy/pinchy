import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createInvite } from "@/lib/invites";
import { deferAuditLog } from "@/lib/audit-deferred";
import { parseOptionalRequestBody } from "@/lib/api-validation";
import { resetPasswordSchema } from "@/lib/schemas/users";
import type { EmailDelivery } from "@/lib/schemas/system-mail";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  // Optional body: the route predates `sendEmail` (#1309), and a client that
  // sends nothing still gets just the link.
  const parsed = await parseOptionalRequestBody(resetPasswordSchema, request);
  if ("error" in parsed) return parsed.error;

  const { userId } = await params;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const invite = await createInvite({
    email: user.email ?? undefined,
    role: user.role,
    type: "reset",
    createdBy: session.user.id,
  });

  // The token exists from here on; a failed send still returns it. Deferred,
  // because the token cannot be rolled back. Whether a mail then went out is
  // the separate `mail.sent` row.
  const viaEmail = Boolean(parsed.data.sendEmail && user.email);
  deferAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: "user.password_reset_requested",
    resource: `user:${user.id}`,
    // An admin can reset their own password; the actor's raw id stays out of detail.
    detail: {
      user: user.id === session.user.id ? { name: user.name } : { id: user.id, name: user.name },
      via: viaEmail ? "email" : "link",
      invite: { id: invite.id },
    },
    outcome: "success",
  });

  let emailDelivery: EmailDelivery | undefined;
  if (parsed.data.sendEmail && user.email) {
    // Loaded only when an email is asked for: with the mailer off, this route
    // must not pull in the mail stack (nodemailer, the domain lookup) at all.
    emailDelivery = await import("@/lib/system-mail/deliver")
      .then(({ deliverLinkEmail }) =>
        deliverLinkEmail({
          request,
          kind: "reset",
          to: user.email,
          token: invite.token,
          expiresAt: invite.expiresAt,
          inviteId: invite.id,
          actor: { id: session.user.id, name: session.user.name, email: session.user.email },
        })
      )
      .catch((err: unknown): EmailDelivery => {
        console.error("[reset] email delivery crashed:", err);
        return { sent: false, error: "Something went wrong sending the email." };
      });
  }

  return NextResponse.json(
    emailDelivery ? { token: invite.token, emailDelivery } : { token: invite.token },
    { status: 201 }
  );
}
