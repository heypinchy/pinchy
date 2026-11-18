import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, costBudgets } from "@/db/schema";
import { withAdmin } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/budgets/[id] — remove a budget. Deliberately NOT license-gated:
 * existing budgets keep being enforced after a license lapses (a lapse must not
 * quietly lift cost protection), so deleting one has to stay possible, or an
 * expired license could leave an instance with chat blocked and no way out.
 */
export const DELETE = withAdmin<RouteContext>(async (_request, { params }, session) => {
  const { id } = await params;
  const notFound = NextResponse.json({ error: "Budget not found" }, { status: 404 });
  if (!isUuid(id)) return notFound;

  const [row] = await db
    .select({
      id: costBudgets.id,
      agentId: costBudgets.agentId,
      agentName: agents.name,
      agentIsPersonal: agents.isPersonal,
      agentOwnerId: agents.ownerId,
      monthlyLimitUsd: costBudgets.monthlyLimitUsd,
      onExceeded: costBudgets.onExceeded,
    })
    .from(costBudgets)
    .leftJoin(agents, eq(agents.id, costBudgets.agentId))
    .where(eq(costBudgets.id, id));
  // Another user's personal agent: answered exactly like a budget that does
  // not exist — GET leaves it out and PUT cannot reach it, for the same reason.
  if (!row || (row.agentIsPersonal && row.agentOwnerId !== session.user.id)) return notFound;

  await db.delete(costBudgets).where(eq(costBudgets.id, id));

  const agent = row.agentId ? { id: row.agentId, name: row.agentName ?? "(deleted)" } : null;
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "budget.deleted",
    resource: `budget:${id}`,
    outcome: "success",
    detail: {
      // The row is gone; the trail carries what it was (AGENTS.md).
      name: agent ? agent.name : "Instance budget",
      budget: agent ? { id, scope: "agent", agent } : { id, scope: "instance" },
      monthlyLimitUsd: Number(row.monthlyLimitUsd),
      onExceeded: row.onExceeded,
    },
  });

  return NextResponse.json({ id });
});
