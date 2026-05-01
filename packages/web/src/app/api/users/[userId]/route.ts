import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users, agents } from "@/db/schema";
import { eq, and, count } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;
  const { role } = await request.json();

  // Validate role value
  if (role !== "admin" && role !== "member") {
    return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
  }

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
  const [updated] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();

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

  const [deactivated] = await db
    .update(users)
    .set({ banned: true, banReason: "Deactivated by admin" })
    .where(eq(users.id, userId))
    .returning();

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

  // Soft-delete personal agents + cleanup workspaces
  for (const agent of personalAgents) {
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent.id));
    deleteWorkspace(agent.id); // synchronous (uses rmSync)
  }

  await regenerateOpenClawConfig();
  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}
