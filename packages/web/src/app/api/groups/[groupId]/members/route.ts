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

  // No license gate: admins need to see memberships to REMOVE users from
  // groups, which must always work (fail-closed carve-out, § 5).
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

  // Fail closed with a carve-out (pricing concept § 5): without an active
  // license, group management is locked — but restriction-TIGHTENING
  // operations must always work. Removing members tightens; adding members
  // requires a license.
  if (addedIds.length > 0 && !(await isEnterprise())) {
    return NextResponse.json(
      {
        error: "License required",
        message:
          "Adding users to groups requires an active license. Removing users from groups always works.",
      },
      { status: 403 }
    );
  }

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

  // Reject unknown user ids with a structured 400. Otherwise the bulk insert
  // below hits a NOT NULL foreign-key violation that surfaces as an unhandled
  // 500 — after the membership wipe has already run. Removed ids always exist
  // (they're current members), so only genuinely-unknown added ids are missing.
  const unknownUserIds = addedIds.filter((id) => !nameMap.has(id));
  if (unknownUserIds.length > 0) {
    return NextResponse.json({ error: "Unknown user ids", ids: unknownUserIds }, { status: 400 });
  }

  // Atomic replace: the membership wipe and the re-insert must commit or roll
  // back together. As two standalone statements, an insert failure (a user
  // deleted in the validation→insert window, or any I/O error) would leave the
  // group wiped with nothing re-added — silent membership loss.
  await db.transaction(async (tx) => {
    await tx.delete(userGroups).where(eq(userGroups.groupId, groupId));
    if (userIds.length > 0) {
      await tx.insert(userGroups).values(userIds.map((userId: string) => ({ userId, groupId })));
    }
  });

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
