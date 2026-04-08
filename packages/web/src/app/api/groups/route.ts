import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups, userGroups } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

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

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const { name, description } = await request.json();

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const [group] = await db
    .insert(groups)
    .values({ name: name.trim(), description: description?.trim() || null })
    .returning();

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "group.created",
      resource: `group:${group.id}`,
      detail: { name: group.name },
    })
  );

  return NextResponse.json(group, { status: 201 });
}
