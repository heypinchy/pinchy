import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, userGroups, groups } from "@/db/schema";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const allUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      banned: users.banned,
    })
    .from(users);

  const allUserGroups = await db
    .select({
      userId: userGroups.userId,
      groupId: userGroups.groupId,
      groupName: groups.name,
    })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id));

  const usersWithGroups = allUsers.map((user) => ({
    ...user,
    groups: allUserGroups
      .filter((ug) => ug.userId === user.id)
      .map((ug) => ({ id: ug.groupId, name: ug.groupName })),
  }));

  return NextResponse.json({ users: usersWithGroups });
}
