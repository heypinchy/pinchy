import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invites, inviteGroups, groups } from "@/db/schema";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const allInvites = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      type: invites.type,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      claimedAt: invites.claimedAt,
    })
    .from(invites);

  const allInviteGroups = await db
    .select({
      inviteId: inviteGroups.inviteId,
      groupId: inviteGroups.groupId,
      groupName: groups.name,
    })
    .from(inviteGroups)
    .innerJoin(groups, eq(inviteGroups.groupId, groups.id));

  const invitesWithGroups = allInvites.map((invite) => ({
    ...invite,
    groups: allInviteGroups
      .filter((ig) => ig.inviteId === invite.id)
      .map((ig) => ({ id: ig.groupId, name: ig.groupName })),
  }));

  return NextResponse.json({ invites: invitesWithGroups });
}
