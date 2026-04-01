import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog, type UpdateDetail } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

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

  // Fetch existing group for 404 check and diff
  const [existing] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!existing) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const [updated] = await db.update(groups).set(data).where(eq(groups.id, groupId)).returning();

  // Build diff of actual changes
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (data.name !== undefined && data.name !== existing.name) {
    changes.name = { from: existing.name, to: data.name };
  }
  if (data.description !== undefined && data.description !== existing.description) {
    changes.description = { from: existing.description, to: data.description };
  }

  if (Object.keys(changes).length > 0) {
    const detail: UpdateDetail = { changes };
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "group.updated",
      resource: `group:${groupId}`,
      detail,
    }).catch(() => {});
  }

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

  await recalculateTelegramAllowStores();

  return NextResponse.json({ success: true });
}
