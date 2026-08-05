import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { canManageAgentWorkflows } from "./authz";

/**
 * The agent fields every agent-scoped Automations route needs: the two the
 * scope gate reads, plus the `{ id, name }` pair the audit snapshot writes.
 */
export interface WorkflowAgent {
  id: string;
  name: string;
  isPersonal: boolean;
  ownerId: string | null;
}

export type WorkflowAgentResult = { agent: WorkflowAgent } | { error: NextResponse };

/**
 * Resolve an agentId to an agent the actor may manage workflows on — the
 * load → 404 → scope-gate → 403 preamble that every agent-scoped Automations
 * route opens with (list, create, connection picker).
 *
 * Single-sourced deliberately: `canManageAgentWorkflows` was already shared,
 * but the lookup and the two HTTP answers around it were copied per route
 * (#1087). That copy is an authorization block, where a drifted duplicate is a
 * latent security bug rather than a style problem — the interesting drift is
 * not a differing message but a route that adds a branch (a deleted agent, a
 * second actor shape) to two of three copies.
 *
 * The 403 wording is a parameter because it is user-visible copy that legitimately
 * differs per route ("access to this agent" when reading, "permission to create a
 * workflow" when writing). Sharing the gate must not silently rewrite either.
 *
 * **A refusal answers 403, and that deliberately differs from `loadChatPageAgent`,
 * which answers 404** ("a member who cannot see an agent should not learn that it
 * exists"). The two are not the same question. That one is a *visibility* gate
 * (`assertAgentAccess`): whoever fails it cannot reach the agent anywhere, so the
 * only thing a 403 would tell them is that it exists. This is a *manage-scope*
 * gate (`canManageAgentWorkflows`), and its ordinary refusal is a shared agent the
 * member sees in their sidebar and chats with daily. "Agent not found" about an
 * agent on their screen is simply false, and it sends them checking the id instead
 * of asking an admin.
 *
 * The other leg — someone else's personal agent, or a restricted one outside the
 * actor's groups — is refused by both gates, so there 403-vs-404 really does
 * confirm existence. It stays 403 knowingly, for two reasons:
 *
 * - There is nothing to enumerate. `agents.id` is `crypto.randomUUID()`, so the
 *   answer only ever speaks about an id the caller already holds; it reveals none
 *   they don't. Holding a foreign agent's id is itself the leak worth chasing, and
 *   this function is not where that happened.
 * - 404 here would close nothing. `getAgentWithAccess` answers 403 for exactly
 *   that invisible agent on every `/api/agents/[agentId]/*` route a plain member
 *   can reach, so an Automations-only 404 would trade a worse error message for a
 *   property the instance does not actually have. Closing the oracle means
 *   changing `getAgentWithAccess` (and the ~10 routes built on it), not this.
 *
 * Both legs are pinned in resolve-agent.test.ts against `assertAgentAccess`
 * itself, so the visibility facts this rests on cannot rot unnoticed.
 */
export async function resolveWorkflowAgent(
  agentId: string,
  actor: { id: string; role: string | null | undefined },
  forbiddenMessage = "You do not have access to this agent"
): Promise<WorkflowAgentResult> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      isPersonal: agents.isPersonal,
      ownerId: agents.ownerId,
    })
    .from(agents)
    .where(eq(agents.id, agentId));

  if (!agent) {
    return { error: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };
  }
  if (!canManageAgentWorkflows(agent, actor)) {
    return { error: NextResponse.json({ error: forbiddenMessage }, { status: 403 }) };
  }
  return { agent };
}

/**
 * The same gate for the two GET routes that take their agentId from the query
 * string, including the `agentId is required` 400 they both open with.
 */
export async function resolveWorkflowAgentFromQuery(
  request: Request,
  actor: { id: string; role: string | null | undefined },
  forbiddenMessage?: string
): Promise<WorkflowAgentResult> {
  const agentId = new URL(request.url).searchParams.get("agentId");
  if (!agentId) {
    return { error: NextResponse.json({ error: "agentId is required" }, { status: 400 }) };
  }
  return resolveWorkflowAgent(agentId, actor, forbiddenMessage);
}
