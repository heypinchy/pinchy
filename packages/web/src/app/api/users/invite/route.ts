import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createInvite } from "@/lib/invites";
import { appendAuditLog } from "@/lib/audit";
import { getLicenseStatus } from "@/lib/enterprise";
import { getSeatUsage } from "@/lib/seat-usage";
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

  const license = await getLicenseStatus();
  if (license.active && license.maxUsers > 0) {
    const usage = await getSeatUsage(license);
    if (usage.used >= license.maxUsers) {
      after(() =>
        appendAuditLog({
          actorType: "user",
          actorId: session.user.id!,
          eventType: "user.invite_blocked",
          detail: {
            email,
            role,
            reason: "seat_cap",
            seatsUsed: usage.used,
            maxUsers: license.maxUsers,
          },
          outcome: "failure",
          error: { message: "Seat cap reached" },
        })
      );
      return NextResponse.json(
        {
          error: "Seat limit reached",
          message: `Your license allows ${license.maxUsers} seats, all are in use. Remove an existing user or pending invitation, or upgrade your subscription.`,
          seatsUsed: usage.used,
          maxUsers: license.maxUsers,
        },
        { status: 403 }
      );
    }
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
      outcome: "success",
    })
  );

  return NextResponse.json(invite, { status: 201 });
}
