import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { inArray } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { email, role, groupIds } = await request.json();

  if (!role || !["admin", "member"].includes(role)) {
    return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
  }

  const invite = await createInvite({ email, role, createdBy: session.user.id, groupIds });

  let auditGroups: Array<{ id: string; name: string }> = [];
  if (groupIds?.length > 0) {
    const groupRows = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(inArray(groups.id, groupIds));
    const nameMap = new Map(groupRows.map((g: { id: string; name: string }) => [g.id, g.name]));
    auditGroups = groupIds.map((id: string) => ({ id, name: nameMap.get(id) ?? id }));
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "user.invited",
      detail: {
        email,
        role,
        ...(auditGroups.length > 0 ? { groups: auditGroups } : {}),
      },
    })
  );

  return NextResponse.json(invite, { status: 201 });
}
