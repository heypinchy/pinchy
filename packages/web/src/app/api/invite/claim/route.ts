// audit-exempt: new-user claim is a self-service action covered by the
// inviter's `user.invited` audit row on the creation side. The reset
// branch is NOT exempt and writes an `auth.password_reset_completed`
// row below, because a password change is security-sensitive regardless
// of who triggers it.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users, userGroups, accounts, sessions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveInviteFlow, claimInvite, getInviteGroupIds } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { waitForAgentInRuntime } from "@/lib/wait-for-agent-in-runtime";
import { getOpenClawClient } from "@/server/openclaw-client";
import { validatePassword } from "@/lib/validate-password";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";

const claimInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().optional(),
  password: z.string(),
});

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
        resource: existingUser.id,
        outcome: "failure",
        error: { message },
        detail: { inviteId: invite.id, type: "reset" },
      });
      return NextResponse.json({ error: "Password reset failed" }, { status: 500 });
    }

    await appendAuditLog({
      actorType: "user",
      actorId: existingUser.id,
      eventType: "auth.password_reset_completed",
      resource: existingUser.id,
      outcome: "success",
      detail: {
        inviteId: invite.id,
        type: "reset",
        target: { id: existingUser.id, name: existingUser.name },
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

  const result = await auth.api.signUpEmail({
    body: { name: name.trim(), email: invite.email!, password },
  });

  if (!result?.user) {
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }

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
    await waitForAgentInRuntime(client, personalAgent.id);
  }

  return NextResponse.json({ success: true }, { status: 201 });
}
