import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { users, groups, userGroups } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { parseRequestBody } from "@/lib/api-validation";

const updateUserGroupsSchema = z.object({
  groupIds: z.array(z.string()),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;
  const parsed = await parseRequestBody(updateUserGroupsSchema, request);
  if ("error" in parsed) return parsed.error;
  const { groupIds } = parsed.data;

  // 1. Fetch user (verify exists, get name for audit)
  const userRows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));

  if (userRows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userName = userRows[0].name;

  // 2. Fetch previous memberships (for diff)
  const previousMemberships = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));

  const previousGroupIds = new Set(previousMemberships.map((m) => m.groupId));
  const newGroupIdSet = new Set(groupIds);

  // 3. Fetch all relevant group names (new + removed) for audit snapshot
  const allRelevantIds = [...new Set([...groupIds, ...previousGroupIds])];
  const groupRows =
    allRelevantIds.length > 0
      ? await db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(groups.id, allRelevantIds))
      : [];
  const nameMap = new Map(groupRows.map((g) => [g.id, g.name]));

  // Reject unknown group ids with a structured 400. Otherwise the bulk insert
  // below hits a NOT NULL foreign-key violation that surfaces as an unhandled
  // 500 — and only after the membership wipe has already run. Previous
  // memberships always exist, so anything missing from nameMap is a genuinely
  // unknown requested id (e.g. a group deleted between page load and submit).
  const unknownGroupIds = groupIds.filter((id: string) => !nameMap.has(id));
  if (unknownGroupIds.length > 0) {
    return NextResponse.json({ error: "Unknown group ids", ids: unknownGroupIds }, { status: 400 });
  }

  // 4. Compute added/removed diff
  const added = groupIds
    .filter((id: string) => !previousGroupIds.has(id))
    .map((id: string) => ({ id, name: nameMap.get(id) ?? id }));

  const removed = [...previousGroupIds]
    .filter((id) => !newGroupIdSet.has(id))
    .map((id) => ({ id, name: nameMap.get(id) ?? id }));

  // Fail closed with a carve-out (pricing concept § 5): without an active
  // license, group management is locked — but restriction-TIGHTENING
  // operations must always work. Removing a user from a group tightens;
  // adding one requires a license.
  if (added.length > 0 && !(await isEnterprise())) {
    return NextResponse.json(
      {
        error: "License required",
        message:
          "Adding users to groups requires an active license. Removing users from groups always works.",
      },
      { status: 403 }
    );
  }

  // 5. Delete all existing userGroups for this userId
  await db.delete(userGroups).where(eq(userGroups.userId, userId));

  // 6. Insert new userGroups (skip if empty)
  if (groupIds.length > 0) {
    await db.insert(userGroups).values(groupIds.map((groupId: string) => ({ userId, groupId })));
  }

  // 7. Schedule audit log via after() so the response isn't blocked and any
  // errors flow through Next's error handler instead of being swallowed.
  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.groups_updated",
      resource: `user:${userId}`,
      detail: {
        userName,
        added,
        removed,
        memberCount: groupIds.length,
      },
      outcome: "success",
    })
  );

  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}
