// Loader for the /invite/[token] page. Returns the invite's flow type so the
// page can render the right UI:
//   - "invite" → new-user claim (name + password form, "Create account")
//   - "reset"  → password reset for an existing user (no name field — see #436,
//     where the shared invite UI silently overwrote the user's display name)
//
// Alongside the type it returns the sign-in email and, for an invite, the
// inviter's display name (#1265), so the page can say who the account is for
// and who sent the link. See `InviteTokenInfo` for why that is safe to hand an
// unauthenticated caller.
//
// audit-exempt: read-only token lookup, no state change.
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { resolveInviteFlow } from "@/lib/invites";
import type { InviteTokenInfo } from "@/lib/schemas/invite";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const flow = await resolveInviteFlow(token);
  if (!flow.ok) {
    return NextResponse.json({ error: flow.error }, { status: flow.status });
  }

  let invitedBy: string | null = null;
  if (flow.type === "invite") {
    // Name only. `invites.createdBy` cascades on user delete, so the row is
    // always there; a blank name falls back to the generic heading. A
    // deactivated inviter isn't named: their name would vouch for a link
    // from someone who is no longer here.
    const inviter = await db.query.users.findFirst({
      where: eq(users.id, flow.invite.createdBy),
      columns: { name: true, banned: true },
    });
    invitedBy = inviter && !inviter.banned ? inviter.name?.trim() || null : null;
  }

  const body: InviteTokenInfo = {
    type: flow.type,
    // A reset resolves its user by this address; an invite without one is
    // refused above (#1263). Either way the account signs in with it.
    email: flow.type === "reset" ? flow.user.email : flow.invite.email,
    invitedBy,
  };
  return NextResponse.json(body, { status: 200 });
}
