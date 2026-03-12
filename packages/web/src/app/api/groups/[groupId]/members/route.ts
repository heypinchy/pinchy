import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups, userGroups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

async function groupExists(groupId: string): Promise<boolean> {
  const rows = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId));
  return rows.length > 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { groupId } = await params;

  if (!(await groupExists(groupId))) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const members = await db
    .select({ userId: userGroups.userId, groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.groupId, groupId));

  return NextResponse.json(members);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { groupId } = await params;
  const { userIds } = await request.json();

  if (!Array.isArray(userIds)) {
    return NextResponse.json({ error: "userIds must be an array" }, { status: 400 });
  }

  if (!userIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "userIds must be an array of strings" }, { status: 400 });
  }

  if (!(await groupExists(groupId))) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
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
