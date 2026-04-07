import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const rows = await db.query.users.findMany({
    columns: {
      id: true,
      name: true,
      email: true,
      role: true,
      banned: true,
    },
    with: {
      userGroups: {
        with: {
          group: { columns: { id: true, name: true } },
        },
      },
    },
  });

  const usersWithGroups = rows.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    banned: user.banned,
    groups: user.userGroups.map((ug) => ({ id: ug.group.id, name: ug.group.name })),
  }));

  return NextResponse.json({ users: usersWithGroups });
}
