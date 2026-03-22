// audit-exempt: password reset generates a token but does not change credentials directly
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createInvite } from "@/lib/invites";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const invite = await createInvite({
    email: user.email ?? undefined,
    role: user.role,
    type: "reset",
    createdBy: session.user.id,
  });

  return NextResponse.json({ token: invite.token }, { status: 201 });
}
