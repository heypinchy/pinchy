import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { userId } = await params;

  const [reactivated] = await db
    .update(users)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(and(eq(users.id, userId), eq(users.banned, true)))
    .returning();

  if (!reactivated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.updated",
      resource: `user:${userId}`,
      detail: { changes: { status: { from: "deactivated", to: "active" } } },
    })
  );

  return NextResponse.json({ success: true });
}
