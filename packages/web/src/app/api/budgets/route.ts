import { NextResponse } from "next/server";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { costBudgets } from "@/db/schema";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { appendAuditLog } from "@/lib/audit";
import { getAgentWithAccess } from "@/lib/agent-access";
import { isEnterprise } from "@/lib/enterprise";
import { getBudgetStatuses } from "@/lib/budgets";
import { upsertBudgetSchema } from "@/lib/schemas/budgets";

/**
 * GET /api/budgets — every budget with this month's spend and state. Admin-only;
 * readable without a license so a lapsed one still shows what is enforced.
 * Budgets on another user's personal agent are left out, for the same reason
 * PUT runs the agent read gate.
 */
export const GET = withAdmin(async (_request, _ctx, session) => {
  return NextResponse.json(await getBudgetStatuses({ viewerId: session.user.id! }));
});

/**
 * PUT /api/budgets — create or replace one budget: the instance's
 * (`agentId: null`) or one agent's. Enterprise, as #36 decided.
 *
 * An agent budget goes through the same read gate as every agent route, so an
 * admin cannot budget — and thereby confirm — a colleague's private Smithers.
 * The instance budget already covers it.
 *
 * Changing the limit re-arms this month's alerts: a warning about the old line
 * says nothing about the new one. Changing only the action keeps them.
 */
export const PUT = withAdmin(async (request, _ctx, session) => {
  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }
  const parsed = await parseRequestBody(upsertBudgetSchema, request);
  if ("error" in parsed) return parsed.error;
  const { agentId, onExceeded } = parsed.data;
  const monthlyLimitUsd = Math.round(parsed.data.monthlyLimitUsd * 100) / 100;

  let agentRef: { id: string; name: string } | null = null;
  if (agentId) {
    const agent = await getAgentWithAccess(agentId, session.user.id!, session.user.role ?? "");
    if (agent instanceof NextResponse) return agent;
    agentRef = { id: agent.id, name: agent.name };
  }
  const budgetRef = (id: string) =>
    agentRef
      ? { id, scope: "agent" as const, agent: agentRef }
      : { id, scope: "instance" as const };

  // Insert-or-nothing first, so two saves racing for one scope cannot both
  // insert: the loser hits the unique constraint quietly and updates instead.
  const [created] = await db
    .insert(costBudgets)
    .values({ agentId, monthlyLimitUsd: monthlyLimitUsd.toFixed(2), onExceeded })
    .onConflictDoNothing({ target: costBudgets.agentId })
    .returning();

  if (created) {
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "budget.created",
      resource: `budget:${created.id}`,
      outcome: "success",
      detail: { budget: budgetRef(created.id), monthlyLimitUsd, onExceeded },
    });
    return NextResponse.json({ id: created.id });
  }

  const [existing] = await db
    .select()
    .from(costBudgets)
    .where(agentId ? eq(costBudgets.agentId, agentId) : isNull(costBudgets.agentId));
  // Deleted between the conflict and this read: nothing left to update.
  if (!existing) {
    return NextResponse.json(
      { error: "The budget changed meanwhile. Try again." },
      { status: 409 }
    );
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const previousLimit = Number(existing.monthlyLimitUsd);
  if (previousLimit !== monthlyLimitUsd) {
    changes.monthlyLimitUsd = { from: previousLimit, to: monthlyLimitUsd };
  }
  if (existing.onExceeded !== onExceeded) {
    changes.onExceeded = { from: existing.onExceeded, to: onExceeded };
  }
  if (Object.keys(changes).length === 0) return NextResponse.json({ id: existing.id });

  await db
    .update(costBudgets)
    .set({
      monthlyLimitUsd: monthlyLimitUsd.toFixed(2),
      onExceeded,
      // A new limit is a new line and earns its own alerts; a new action on
      // the same line does not — those alerts were about exactly this line.
      ...(changes.monthlyLimitUsd ? { warnedPeriod: null, exceededPeriod: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(costBudgets.id, existing.id));
  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "budget.updated",
    resource: `budget:${existing.id}`,
    outcome: "success",
    detail: { budget: budgetRef(existing.id), changes },
  });
  return NextResponse.json({ id: existing.id });
});
