// Loader for the /invite/[token] page. Returns the invite's flow type so the
// page can render the right UI:
//   - "invite" → new-user claim (name + password form, "Create account")
//   - "reset"  → password reset for an existing user (no name field — see #436,
//     where the shared invite UI silently overwrote the user's display name)
//
// audit-exempt: read-only token lookup, no state change.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateInviteToken } from "@/lib/invites";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const invite = await validateInviteToken(token);
  if (!invite) {
    return NextResponse.json({ error: "Invalid or expired invite link" }, { status: 410 });
  }

  if (invite.type === "reset") {
    const existingUser = invite.email
      ? await db.query.users.findFirst({ where: eq(users.email, invite.email) })
      : null;

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ type: "reset" }, { status: 200 });
  }

  return NextResponse.json({ type: "invite" }, { status: 200 });
}
