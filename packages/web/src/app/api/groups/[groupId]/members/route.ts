import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { userGroups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;
  const { groupId } = await params;
  const { userIds } = await request.json();

  if (!Array.isArray(userIds)) {
    return NextResponse.json({ error: "userIds must be an array" }, { status: 400 });
  }

  await db.delete(userGroups).where(eq(userGroups.groupId, groupId));

  if (userIds.length > 0) {
    await db.insert(userGroups).values(userIds.map((userId: string) => ({ userId, groupId })));
  }

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "group.members_updated",
    resource: `group:${groupId}`,
    detail: { memberCount: userIds.length },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
