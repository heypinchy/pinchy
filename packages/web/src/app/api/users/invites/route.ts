import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const rows = await db.query.invites.findMany({
    columns: {
      id: true,
      email: true,
      role: true,
      type: true,
      createdAt: true,
      expiresAt: true,
      claimedAt: true,
    },
    with: {
      inviteGroups: {
        with: {
          group: { columns: { id: true, name: true } },
        },
      },
    },
  });

  const invitesWithGroups = rows.map((invite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    type: invite.type,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    claimedAt: invite.claimedAt,
    groups: invite.inviteGroups.map((ig) => ({ id: ig.group.id, name: ig.group.name })),
  }));

  return NextResponse.json({ invites: invitesWithGroups });
}
