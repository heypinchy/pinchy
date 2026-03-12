import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { users, groups, userGroups } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { userId } = await params;
  const { groupIds } = await request.json();

  if (!Array.isArray(groupIds)) {
    return NextResponse.json({ error: "groupIds must be an array" }, { status: 400 });
  }

  if (!groupIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "groupIds must be an array of strings" }, { status: 400 });
  }

  // 1. Fetch user (verify exists, get name for audit)
  const userRows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));

  if (userRows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userName = userRows[0].name;

  // 2. Fetch new group names (for audit snapshot)
  const newGroupNames =
    groupIds.length > 0
      ? await db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(groups.id, groupIds))
      : [];

  // 3. Fetch previous memberships (for diff)
  const previousMemberships = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));

  const previousGroupIds = new Set(previousMemberships.map((m) => m.groupId));
  const newGroupIdSet = new Set(groupIds);

  // 4. Compute added/removed diff
  const added = newGroupNames
    .filter((g) => !previousGroupIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name }));

  const removed = [...previousGroupIds]
    .filter((id) => !newGroupIdSet.has(id))
    .map((id) => ({ id }));

  // 5. Delete all existing userGroups for this userId
  await db.delete(userGroups).where(eq(userGroups.userId, userId));

  // 6. Insert new userGroups (skip if empty)
  if (groupIds.length > 0) {
    await db.insert(userGroups).values(groupIds.map((groupId: string) => ({ userId, groupId })));
  }

  // 7. Append audit log
  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "user.groups_updated",
    resource: `user:${userId}`,
    detail: {
      userName,
      added,
      removed,
      groupCount: groupIds.length,
    },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
