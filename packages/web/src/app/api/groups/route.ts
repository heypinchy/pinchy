import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { groups, userGroups } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const allGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: count(userGroups.userId),
    })
    .from(groups)
    .leftJoin(userGroups, eq(groups.id, userGroups.groupId))
    .groupBy(groups.id);

  return NextResponse.json(allGroups);
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { name, description } = await request.json();

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const [group] = await db
    .insert(groups)
    .values({ name: name.trim(), description: description?.trim() || null })
    .returning();

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "group.created",
    resource: `group:${group.id}`,
    detail: { name: group.name },
  }).catch(() => {});

  return NextResponse.json(group, { status: 201 });
}
