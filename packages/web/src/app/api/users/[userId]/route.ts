import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users, agents, sessions } from "@/db/schema";
import { eq, and, count, inArray } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { parseRequestBody } from "@/lib/api-validation";

const updateUserSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;
  const parsed = await parseRequestBody(updateUserSchema, request);
  if ("error" in parsed) return parsed.error;
  const { role } = parsed.data;

  // Cannot change own role
  if (userId === session.user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  // Fetch user to verify existence and get current role
  const [user] = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // If demoting an admin, check they're not the last one
  if (user.role === "admin" && role === "member") {
    const [{ count: adminCount }] = await db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.banned, false)));

    if (adminCount <= 1) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
  }

  // Update role
  await db.update(users).set({ role }).where(eq(users.id, userId));

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.role_updated",
      resource: `user:${userId}`,
      detail: { changes: { role: { from: user.role, to: role } }, userName: user.name },
      outcome: "success",
    })
  );

  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;

  if (userId === session.user.id) {
    return NextResponse.json({ error: "Cannot deactivate your own account" }, { status: 400 });
  }

  // Find user's personal agents to soft-delete and clean up workspaces
  const personalAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, userId), eq(agents.isPersonal, true)));

  // Atomic deactivation: the ban, the session revocation, and the personal-
  // agent soft-delete must commit or roll back together. As standalone
  // statements, a failure partway through (e.g. the session delete) would
  // leave the user already banned with sessions and agents untouched, or vice
  // versa — an inconsistent, partially-deactivated account. The filesystem
  // workspace cleanup below stays OUTSIDE the transaction on purpose: an rm()
  // has no place in a DB rollback.
  const deactivated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ banned: true, banReason: "Deactivated by admin" })
      .where(eq(users.id, userId))
      .returning();

    if (!row) return undefined;

    // Revoke the user's active sessions immediately. Better Auth only
    // enforces the `banned` flag at session-creation time, not on session
    // reads, so an already-issued cookie would otherwise keep full access
    // (incl. admin) until natural expiry. This mirrors the official
    // admin.banUser behavior and the invite/claim reset flow, which both
    // delete sessions.
    await tx.delete(sessions).where(eq(sessions.userId, userId));

    // Soft-delete every personal agent in one batched update instead of one
    // per agent.
    if (personalAgents.length > 0) {
      await tx
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            agents.id,
            personalAgents.map((a) => a.id)
          )
        );
    }

    return row;
  });

  if (!deactivated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.deleted",
      resource: `user:${userId}`,
      // GDPR Art. 17: never record the email here. The audit log is
      // HMAC-signed and append-only, so we cannot redact later. userId
      // is in `resource`; name is enough for human-readable diffing.
      detail: { name: deactivated.name },
      outcome: "success",
    })
  );

  // Cleanup workspaces (filesystem, not DB — deliberately outside the
  // transaction above).
  //
  // A personal agent's workspace (KB corpora especially) can be GB-sized.
  // deleteWorkspace() itself now uses fs.promises.rm rather than rmSync, so it
  // no longer blocks the Node event loop while it walks the directory — but
  // awaiting it here would still hold this response open for however long
  // that takes. The ban and soft-delete above already committed, so the
  // user's deactivation is complete and auditable regardless of how long
  // cleanup takes.
  //
  // RETURN the promise rather than discarding it: after() awaits what its
  // callback returns, which costs nothing here (the response is already on
  // its way) and is what keeps the request lifecycle open until cleanup
  // finishes. A discarded promise also puts any rejection outside anyone's
  // reach — deleteWorkspace() swallows rm() failures, but its agent-id
  // validation throws before that catch, and Node answers an unhandled
  // rejection by killing the process.
  //
  // Residual risk, stated rather than papered over: this is best-effort. A
  // hard crash between the response and the rm() completing leaves the
  // directory on disk, and nothing sweeps for orphaned workspaces. That costs
  // disk, never correctness — deleteWorkspace() is idempotent (force: true)
  // and logs its own failures.
  after(() => Promise.all(personalAgents.map((agent) => deleteWorkspace(agent.id))));

  await regenerateOpenClawConfig();
  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}
