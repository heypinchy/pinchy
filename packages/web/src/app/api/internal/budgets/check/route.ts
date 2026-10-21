import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { budgetCheckSchema, type BudgetCheckInput } from "@/lib/schemas/budgets";
import { budgetExhaustedMessage, getExhaustedBlockingBudget } from "@/lib/budgets";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { db } from "@/db";
import { agents, channelLinks } from "@/db/schema";
import { directSessionUserId } from "@/lib/session-key";
import { findUserIdIgnoringCase } from "@/lib/user-id-case";

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

  // Everything from here on only shapes the audit row and the sentence. None
  // of it may reopen the budget: the plugin reads any error answer as "let
  // the run through", so a lookup that fails falls back instead of throwing.
  const [agentRef, actor] = await Promise.all([
    findAgentRef(input.agentId),
    resolveActor(input).catch(() => agentActor(input.agentId)),
  ]);

  const auditEntry = {
    ...actor,
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

type Actor = { actorType: "user" | "agent"; actorId: string };

function agentActor(agentId: string): Actor {
  return { actorType: "agent", actorId: agentId };
}

/** The agent's name for the sentence and the audit snapshot; its id if unknown. */
async function findAgentRef(agentId: string): Promise<{ id: string; name: string }> {
  try {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: { id: true, name: true },
    });
    if (agent) return agent;
  } catch {
    // Fall through: the refusal does not depend on the name.
  }
  return { id: agentId, name: agentId };
}

/**
 * Who was refused. A channel run names the sender's account on that channel,
 * which `channel_links` maps back to the Pinchy user who linked it — asked
 * first, because a channel DM's session key can look like a direct one
 * (`dmScope: "per-peer"`) while naming the peer, not a Pinchy user. A browser
 * session key names the Pinchy user. Neither → the agent itself (an
 * automation, a heartbeat, an unlinked sender). The sender's channel id never
 * goes into `detail`: it is their identity on another service.
 */
async function resolveActor(input: BudgetCheckInput): Promise<Actor> {
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
  const sessionUser = directSessionUserId(input.sessionKey);
  if (sessionUser) {
    const userId = await findUserIdIgnoringCase(sessionUser);
    if (userId) return { actorType: "user", actorId: userId };
  }
  return agentActor(input.agentId);
}
