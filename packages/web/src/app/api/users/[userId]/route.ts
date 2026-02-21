import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users, agents } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";
import { appendAuditLog } from "@/lib/audit";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;

  if (userId === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  // Find user's personal agents to clean up workspaces
  const personalAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, userId), eq(agents.isPersonal, true)));

  // Delete user (cascades to personal agents via FK)
  const deleted = await db.delete(users).where(eq(users.id, userId)).returning();

  if (deleted.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "user.deleted",
    resource: `user:${userId}`,
    detail: { email: deleted[0].email },
  }).catch(() => {});

  // Cleanup workspace files for deleted agents
  for (const agent of personalAgents) {
    deleteWorkspace(agent.id);
  }

  await regenerateOpenClawConfig();

  return NextResponse.json({ success: true });
}
