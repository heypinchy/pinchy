import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { budgetCheckSchema, type BudgetCheckInput } from "@/lib/schemas/budgets";
import { budgetExhaustedMessage, getExhaustedBlockingBudget } from "@/lib/budgets";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { db } from "@/db";
import { agents, channelLinks, users } from "@/db/schema";

/**
 * The runtime half of a blocking cost budget (#36). pinchy-audit's
 * `before_agent_run` hook asks this before every OpenClaw run — browser,
 * Telegram, automations, any channel — so a used-up budget stops the run before
 * the model reads the prompt. Design of record:
 * plans/2026-10-19-budget-runtime-gate-design.md.
 *
 * A POST, not a GET, because a refusal writes `chat.policy_refused`. A pass
 * writes nothing: it changes no state.
 */
export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(budgetCheckSchema, request);
  if ("error" in parsed) return parsed.error;
  const input = parsed.data;

  // An agent Pinchy does not know (OpenClaw's own default agent, say) cannot
  // have a budget of its own, but the instance budget still caps it.
  const budget = await getExhaustedBlockingBudget(input.agentId);
  if (!budget) return NextResponse.json({ blocked: false });

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, input.agentId),
    columns: { id: true, name: true },
  });
  const agentRef = agent ?? { id: input.agentId, name: input.agentId };

  const auditEntry = {
    ...(await resolveActor(input)),
    eventType: "chat.policy_refused" as const,
    resource: `agent:${agentRef.id}`,
    detail: {
      reason: "budget_exhausted",
      agent: { id: agentRef.id, name: agentRef.name },
      budget: { id: budget.id, period: budget.period },
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
    },
    outcome: "failure" as const,
  };
  // The refusal stands whether or not its row could be written: an audit
  // outage must not reopen a budget.
  try {
    await appendAuditLog(auditEntry);
  } catch (err) {
    recordAuditFailure(err, auditEntry);
  }

  return NextResponse.json({
    blocked: true,
    message: budgetExhaustedMessage(agentRef.name, budget),
  });
}

/**
 * Who was refused. A browser session key names the Pinchy user; a channel run
 * names the sender's account on that channel, which `channel_links` maps back
 * to the Pinchy user who linked it. Neither → the agent itself (an automation,
 * a heartbeat, an unlinked sender). The sender's channel id never goes into
 * `detail`: it is their identity on another service.
 */
async function resolveActor(
  input: BudgetCheckInput
): Promise<{ actorType: "user" | "agent"; actorId: string }> {
  // A userId never contains a colon, but a `:<chatId>` segment can follow it.
  const sessionUser = input.sessionKey
    ? /^agent:[^:]+:direct:([^:]+)/.exec(input.sessionKey)?.[1]
    : undefined;
  if (sessionUser) {
    // OpenClaw lowercases session keys; users.id is case-preserving.
    const user = await db.query.users.findFirst({
      where: sql`lower(${users.id}) = ${sessionUser.toLowerCase()}`,
      columns: { id: true },
    });
    if (user) return { actorType: "user", actorId: user.id };
  }
  if (input.channel && input.senderId) {
    const link = await db.query.channelLinks.findFirst({
      where: and(
        eq(channelLinks.channel, input.channel),
        eq(channelLinks.channelUserId, input.senderId)
      ),
      columns: { userId: true },
    });
    if (link) return { actorType: "user", actorId: link.userId };
  }
  return { actorType: "agent", actorId: input.agentId };
}
