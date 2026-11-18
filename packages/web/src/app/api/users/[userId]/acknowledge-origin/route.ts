import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { acknowledgeUserOriginSchema } from "@/lib/schemas/users";
import { ORIGIN_ACKNOWLEDGED_EVENT } from "@/lib/user-provenance";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * "Mark as known": an admin vouches for an account the provenance check
 * flagged (lib/user-provenance.ts). The audit row written here IS the
 * acknowledgement — findUnknownOriginUsers reads it back — so it is awaited,
 * and a failed write fails the request instead of reporting a success that
 * was never stored. Allowed on the admin's own account on purpose: a demoted
 * setup admin, or an admin who signed up before setup ran, may be the only
 * admin left to clear it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const parsed = await parseRequestBody(acknowledgeUserOriginSchema, request);
  if ("error" in parsed) return parsed.error;

  const { userId } = await params;
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id,
    eventType: ORIGIN_ACKNOWLEDGED_EVENT,
    resource: `user:${user.id}`,
    // Name only. The account's id is in `resource`, which is what the
    // provenance check reads — and this route works on the admin's own
    // account, where a `user.id` here would be the ACTING admin's raw id in
    // the immutable detail, out of crypto-erasure's reach (#824).
    detail: { user: { name: user.name } },
    outcome: "success",
  });

  return NextResponse.json({ success: true });
}
