import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { findUnknownOriginUsers } from "@/lib/user-provenance";

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

  // Accounts neither the setup wizard nor a claimed invite created — in
  // practice, self-registered through the sign-up endpoint earlier releases
  // left open. Settings → Users lists them in a banner (lib/user-provenance.ts).
  const unknownOrigin = new Set((await findUnknownOriginUsers()).map((u) => u.id));

  const usersWithGroups = rows.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    banned: user.banned,
    groups: user.userGroups.map((ug) => ({ id: ug.group.id, name: ug.group.name })),
    unknownOrigin: unknownOrigin.has(user.id),
  }));

  return NextResponse.json({ users: usersWithGroups });
}
