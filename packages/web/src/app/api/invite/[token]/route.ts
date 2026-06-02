// Loader for the /invite/[token] page. Returns the invite's flow type so the
// page can render the right UI:
//   - "invite" → new-user claim (name + password form, "Create account")
//   - "reset"  → password reset for an existing user (no name field — see #436,
//     where the shared invite UI silently overwrote the user's display name)
//
// audit-exempt: read-only token lookup, no state change.
import { NextRequest, NextResponse } from "next/server";
import { resolveInviteFlow } from "@/lib/invites";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const flow = await resolveInviteFlow(token);
  if (!flow.ok) {
    return NextResponse.json({ error: flow.error }, { status: flow.status });
  }

  return NextResponse.json({ type: flow.type }, { status: 200 });
}
