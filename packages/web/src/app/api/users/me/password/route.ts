import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { validatePassword } from "@/lib/validate-password";
import { appendAuditLog } from "@/lib/audit";

// Shape only — length/breach-list policy is enforced post-parse via
// validatePassword() so the same rules apply to setup, invite-claim, and
// password-change without drifting between routes.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string(),
});

export const POST = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(changePasswordSchema, request);
  if ("error" in parsed) return parsed.error;
  const { currentPassword, newPassword } = parsed.data;

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  // A password change is a security-sensitive credential mutation, so it is
  // audited regardless of who triggers it — same reasoning as the invite/claim
  // reset branch. Never log the password values themselves.
  const userId = session.user.id;

  try {
    await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      },
      headers: await headers(),
    });
  } catch {
    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "auth.password_changed",
      resource: userId,
      outcome: "failure",
      error: { message: "Invalid current password" },
    });
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
  }

  await appendAuditLog({
    actorType: "user",
    actorId: userId,
    eventType: "auth.password_changed",
    resource: userId,
    outcome: "success",
  });

  return NextResponse.json({ success: true });
});
