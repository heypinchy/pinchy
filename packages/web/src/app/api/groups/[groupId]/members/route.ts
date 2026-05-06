import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups, userGroups, users } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { parseRequestBody } from "@/lib/api-validation";
import { setMembersSchema } from "@/lib/schemas/groups";

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
  const parsed = await parseRequestBody(setMembersSchema, request);
  if ("error" in parsed) return parsed.error;
  const { userIds } = parsed.data;

  if (!(await groupExists(groupId))) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  // Load existing members to compute diff
  const existingMembers = await db
    .select({ userId: userGroups.userId })
    .from(userGroups)
    .where(eq(userGroups.groupId, groupId));
  const existingIds = new Set(existingMembers.map((m) => m.userId));
  const newIds = new Set(userIds as string[]);

  const addedIds = [...newIds].filter((id) => !existingIds.has(id));
  const removedIds = [...existingIds].filter((id) => !newIds.has(id));

  // Resolve names for changed users
  const changedIds = [...addedIds, ...removedIds];
  const userNames =
    changedIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, changedIds))
      : [];
  const nameMap = new Map(userNames.map((u) => [u.id, u.name]));

  await db.delete(userGroups).where(eq(userGroups.groupId, groupId));

  if (userIds.length > 0) {
    await db.insert(userGroups).values(userIds.map((userId: string) => ({ userId, groupId })));
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "group.members_updated",
      resource: `group:${groupId}`,
      detail: {
        added: addedIds.map((id) => ({ id, name: nameMap.get(id) ?? id })),
        removed: removedIds.map((id) => ({ id, name: nameMap.get(id) ?? id })),
        memberCount: userIds.length,
      },
      outcome: "success",
    })
  );

  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}
