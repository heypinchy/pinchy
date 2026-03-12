import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { groupId } = await params;
  const { name, description } = await request.json();

  const data: { name?: string; description?: string | null; updatedAt?: Date } = {
    updatedAt: new Date(),
  };
  if (name !== undefined) {
    const trimmed = name.trim();
    if (trimmed === "") {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }
    data.name = trimmed;
  }
  if (description !== undefined) data.description = description?.trim() || null;

  const [updated] = await db.update(groups).set(data).where(eq(groups.id, groupId)).returning();

  if (!updated) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "group.updated",
    resource: `group:${groupId}`,
    detail: { changes: Object.keys(data) },
  }).catch(() => {});

  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { groupId } = await params;

  const [deleted] = await db.delete(groups).where(eq(groups.id, groupId)).returning();

  if (!deleted) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "group.deleted",
    resource: `group:${groupId}`,
    detail: { name: deleted.name },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
