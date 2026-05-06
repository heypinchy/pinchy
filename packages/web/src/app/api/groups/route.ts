import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { db } from "@/db";
import { groups, userGroups } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { createGroupSchema } from "@/lib/schemas/groups";

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

  const parsed = await parseRequestBody(createGroupSchema, request);
  if ("error" in parsed) return parsed.error;
  const { name, description } = parsed.data;

  const [group] = await db
    .insert(groups)
    .values({ name, description: description?.trim() || null })
    .returning();

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "group.created",
      resource: `group:${group.id}`,
      detail: { name: group.name },
      outcome: "success",
    })
  );

  return NextResponse.json(group, { status: 201 });
}
