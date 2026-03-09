import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { email, role } = await request.json();

  if (!role || !["admin", "member"].includes(role)) {
    return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
  }

  const invite = await createInvite({ email, role, createdBy: session.user.id });

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "user.invited",
    detail: { email, role },
  }).catch(() => {});

  return NextResponse.json(invite, { status: 201 });
}
