import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "better-auth/crypto";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users, userGroups, accounts, sessions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveInviteFlow, claimInvite, getInviteGroupIds } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { waitForAgentInRuntimeOnClient } from "@/server/agent-readiness";
import { getOpenClawClient } from "@/server/openclaw-client";
import { validatePassword } from "@/lib/validate-password";
import { parseRequestBody } from "@/lib/api-validation";
import { claimInviteSchema } from "@/lib/schemas/invite";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";

export async function POST(request: NextRequest) {
  const parsed = await parseRequestBody(claimInviteSchema, request);
  if ("error" in parsed) return parsed.error;
  const { token, name, password } = parsed.data;

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  // Shared with the GET /api/invite/[token] loader so the two endpoints can
  // never disagree on what a token means (410 unknown/expired, 404 reset whose
  // user is gone).
  const flow = await resolveInviteFlow(token);
  if (!flow.ok) {
    if (flow.reason === "invite_has_no_email") {
      await auditFailedAccountCreation(flow.invite, name, "invite_has_no_email", flow.error);
    }
    return NextResponse.json({ error: flow.error }, { status: flow.status });
  }
  const { invite } = flow;

  if (flow.type === "reset") {
    const existingUser = flow.user;

    // Hash the new password and write it directly to the Better Auth
    // accounts table. We can't use Better Auth's admin-plugin endpoint
    // `setUserPassword` here: it requires an admin session in the request
    // headers, which a self-service invite-claim flow does not have.
    // (The admin plugin rejects every unauthenticated call with 401,
    // which is the bug that left every reset invite broken until this
    // fix landed.) Same primitive used by lib/reset-admin.ts.
    const hashedPassword = await hashPassword(password);

    try {
      // All three writes participate in a single transaction:
      //   1. update credential password
      //   2. revoke every active session for this user — without this, a
      //      stale or leaked session token survives the reset and the
      //      reset's recovery semantics are broken
      //   3. mark the invite claimed
      // If any step fails the whole reset rolls back; the user keeps
      // their old password and the invite token stays usable.
      //
      // A reset must NEVER touch users.name (#436): the recovery flow has no
      // legitimate reason to rename the account, and silently overwriting the
      // display name with whatever the form carried was data loss. The page
      // hides the name field; the route ignores `name` on reset as defense in
      // depth.
      await db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ password: hashedPassword })
          .where(and(eq(accounts.userId, existingUser.id), eq(accounts.providerId, "credential")));

        await tx.delete(sessions).where(eq(sessions.userId, existingUser.id));

        await claimInvite(invite.tokenHash, existingUser.id, tx);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      await appendAuditLog({
        actorType: "user",
        actorId: existingUser.id,
        eventType: "auth.password_reset_completed",
        resource: `user:${existingUser.id}`,
        outcome: "failure",
        error: { message },
        detail: { invite: { id: invite.id }, type: "reset" },
      });
      return NextResponse.json({ error: "Password reset failed" }, { status: 500 });
    }

    await appendAuditLog({
      actorType: "user",
      actorId: existingUser.id,
      eventType: "auth.password_reset_completed",
      resource: `user:${existingUser.id}`,
      outcome: "success",
      detail: {
        invite: { id: invite.id },
        type: "reset",
        // The actor is the target: its raw id stays in `resource`, never in detail (#824).
        target: { name: existingUser.name },
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  }

  // New user invite. Name is `z.string().optional()` so the `typeof` check
  // is already guaranteed by the schema; just verify it was supplied and
  // isn't whitespace-only.
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof auth.api.signUpEmail>> | null = null;
  // Kept when signUpEmail resolves without a user rather than throwing.
  let signUpError = "Sign-up returned no user";
  try {
    result = await auth.api.signUpEmail({
      // `flow`, not the destructured `invite`: only the narrowed flow knows
      // the email is present.
      body: { name: name.trim(), email: flow.invite.email, password },
    });
  } catch (err) {
    // A library message is not ours to vouch for: scrub any address it carries.
    signUpError = safeProviderError(err instanceof Error ? err.message : "unknown");
  }

  if (!result?.user) {
    await auditFailedAccountCreation(invite, name, "sign_up_failed", signUpError);
    return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
  }

  // The inviter's `user.invited` row says an invite was issued; this one says
  // it became an account. Deferred: the account exists and cannot be rolled
  // back. Actor is the new user (pseudonymized on write) — so no raw user id
  // and no email in detail (#824).
  deferAuditLog({
    actorType: "user",
    actorId: result.user.id,
    eventType: "user.created",
    detail: {
      name: auditSafeName(name),
      role: invite.role,
      via: "invite",
      invite: { id: invite.id },
    },
    outcome: "success",
  });

  if (invite.role !== "member") {
    await db.update(users).set({ role: invite.role }).where(eq(users.id, result.user.id));
  }

  // Assign invite groups to new user
  const groupIds = await getInviteGroupIds(invite.id);
  if (groupIds.length > 0) {
    await db
      .insert(userGroups)
      .values(groupIds.map((groupId) => ({ userId: result.user.id, groupId })));
  }

  const personalAgent = await seedPersonalAgent(result.user.id, invite.role === "admin");
  await claimInvite(invite.tokenHash, result.user.id);
  await regenerateOpenClawConfig();

  // Same race POST /api/agents guards against (#193 follow-up): the
  // newly-seeded personal agent isn't visible in OC's runtime until the
  // fire-and-forget config.apply finishes its hot-reload. The invite-
  // claimed user typically lands on the chat page immediately after this
  // response, so we wait until OC's runtime acknowledges the agent before
  // returning 201. Best-effort with a 5 s cap; falls through silently if
  // OC isn't connected (test env, pre-setup state).
  let client = null;
  try {
    client = getOpenClawClient();
  } catch {
    // OC client not initialised — skip the wait.
  }
  if (personalAgent?.id) {
    await waitForAgentInRuntimeOnClient(client, personalAgent.id);
  }

  return NextResponse.json({ success: true }, { status: 201 });
}

const AUDIT_NAME_MAX_CHARS = 200;

/**
 * Cap by code point, not UTF-16 unit, so the cut never splits an emoji, and
 * replace any lone surrogate or NUL the client sent: Postgres jsonb refuses
 * them, and the audit write would throw.
 */
function auditSafeName(name: string): string {
  return Array.from(name.trim())
    .slice(0, AUDIT_NAME_MAX_CHARS)
    .join("")
    .replace(/[\uD800-\uDFFF\u0000]/gu, "\uFFFD");
}

/**
 * The failure twin of the `user.created` row a successful claim writes. There
 * is no account to act as, so the actor is the claim flow itself. No email in
 * detail, as on the success row.
 */
async function auditFailedAccountCreation(
  invite: { id: string; role: string },
  name: string | undefined,
  reason: "invite_has_no_email" | "sign_up_failed",
  message: string
): Promise<void> {
  await appendAuditLog({
    actorType: "system",
    actorId: "invite-claim",
    eventType: "user.created",
    detail: {
      // The name is whoever holds the link's to choose; cap it so it can't
      // push the detail past the size limit and take invite and reason with it.
      ...(name?.trim() ? { name: auditSafeName(name) } : {}),
      role: invite.role,
      via: "invite",
      invite: { id: invite.id },
      reason,
    },
    outcome: "failure",
    error: { message },
  });
}
