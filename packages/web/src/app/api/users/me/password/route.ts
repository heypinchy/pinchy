// audit-exempt: users changing their own password is a self-service action
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { validatePassword } from "@/lib/validate-password";

// Shape only — length/breach-list policy is enforced post-parse via
// validatePassword() so the same rules apply to setup, invite-claim, and
// password-change without drifting between routes.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string(),
});

export const POST = withAuth(async (request) => {
  const parsed = await parseRequestBody(changePasswordSchema, request);
  if ("error" in parsed) return parsed.error;
  const { currentPassword, newPassword } = parsed.data;

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      },
      headers: await headers(),
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
  }
});
