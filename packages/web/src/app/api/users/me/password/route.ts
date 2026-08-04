import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { validatePassword } from "@/lib/validate-password";
import { appendAuditLog } from "@/lib/audit";
import {
  tryAcquirePasswordChangeSlot,
  claimPasswordChangeRateLimitAuditSlot,
} from "@/lib/password-change-rate-limiter";

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

  // Better Auth's own `/change-password` rate limit (lib/auth.ts) never
  // applies to this route: it's reached through `auth.api.changePassword`,
  // which bypasses the HTTP router the limiter's `onRequest` hook lives in —
  // the same bypass `@/lib/api-auth` documents for `/api/v1/*`. Without this,
  // a session holder could brute-force `currentPassword` without limit. Gated
  // before the Better Auth call so a blocked attempt never reaches it; the
  // write itself is throttled to one row per window (see
  // claimPasswordChangeRateLimitAuditSlot) so a brute-force burst can't flood
  // the audit trail either.
  if (!tryAcquirePasswordChangeSlot(userId)) {
    const slot = claimPasswordChangeRateLimitAuditSlot(userId);
    if (slot.write) {
      await appendAuditLog({
        actorType: "user",
        actorId: userId,
        eventType: "auth.password_changed",
        resource: userId,
        outcome: "failure",
        error: { message: "Rate limit exceeded" },
        detail: slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : undefined,
      });
    }
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  let changePasswordHeaders: Headers | undefined;
  try {
    // revokeOtherSessions: true — post-compromise hardening. A stolen session
    // is the classic reason someone changes their password, and leaving it
    // valid afterward defeats the point (the invite/claim reset branch makes
    // the same call for the same reason). Better Auth's implementation
    // actually revokes ALL of the user's sessions — including this request's
    // own — and mints a fresh one for the caller
    // (better-auth/dist/api/routes/update-user.mjs), so `returnHeaders: true`
    // is required to capture that replacement session's Set-Cookie below;
    // without forwarding it, this browser would be logged out immediately
    // after a successful change.
    const result = await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
      returnHeaders: true,
    });
    changePasswordHeaders = result.headers;
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

  const response = NextResponse.json({ success: true });
  for (const cookie of changePasswordHeaders?.getSetCookie() ?? []) {
    response.headers.append("Set-Cookie", cookie);
  }
  return response;
});
