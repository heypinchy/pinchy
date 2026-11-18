import { NextResponse } from "next/server";

import { getAgentWithAccess } from "@/lib/agent-access";
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
 * read-gate → scope-gate preamble that every agent-scoped Automations route
 * opens with (list, create, connection picker).
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
 * **Two gates, in this order: can you SEE this agent, and only then may you
 * manage its workflows.** The order is the whole point, and it is what closes
 * the existence oracle these routes used to carry (#880).
 *
 * The read gate is `getAgentWithAccess`, which answers 404 — byte-identical to
 * an agent that does not exist — for an agent the caller may not see. Its
 * docblock carries the criterion: a distinguishable error is fine when the
 * caller can already enumerate the resource, and an oracle when they cannot.
 * Nobody can enumerate someone else's personal agent (`getVisibleAgents`
 * withholds them from every caller, admins included), so answering 403 here
 * disclosed exactly what the rest of the product refuses to. Any logged-in
 * member could hand these two routes an id and learn whether it was real.
 *
 * The scope gate stays 403, and that is preserved rather than swept away: its
 * ORDINARY refusal is a shared agent the member sees in their sidebar and chats
 * with daily. "Agent not found" about an agent on their screen is simply false,
 * and it sends them checking the id instead of asking an admin. Having passed
 * the read gate, they already know it exists, so 403 discloses nothing.
 *
 * The refusal from the read gate is passed through **untouched**. Rebuilding it
 * here would let this file re-open the oracle while `agent-access` stayed
 * correct — the response, not merely the status, is the thing being shared.
 *
 * Two consequences worth naming, because both are narrowings this layering
 * causes rather than merely permits:
 *
 * - The read gate reads `active_agents`, so a soft-deleted agent now answers
 *   404 instead of accepting workflow calls. That is the right answer and was
 *   not previously true.
 * - **An admin no longer reaches someone else's personal agent here.**
 *   `canManageAgentWorkflows` returns true for any admin on any agent, while
 *   `assertAgentAccess` holds personal agents private to their owner *including
 *   admins* — its own comment insists the admin fast-path must not bypass that.
 *   The Automations API was the one place those two rules met, and it used to
 *   resolve them in favour of the scope rule, granting admins a reach into a
 *   colleague's private agent that no other agent-scoped surface gives them.
 *   Nothing in the product could exercise it: the Automations tab lives on
 *   `/chat/[agentId]/settings`, which loads its agent through
 *   `GET /api/agents/[agentId]` — gated by this same read gate since #1148 — so
 *   that fetch already answers 404 for exactly this case and the tab renders
 *   with no agent at all. This was the last route under that page still saying
 *   otherwise, reachable only by hand against an id obtained out of band.
 *   Running the read gate first settles it the way the rest of the product
 *   already had. The emergency capability
 *   survives one route down: `PATCH`/`DELETE /api/automations/[id]` is keyed by
 *   workflow id and still lets an admin stop a runaway automation they already
 *   hold the id for — acting on a known workflow, with no way to find one.
 *
 * The legs are pinned in resolve-agent.test.ts against `assertAgentAccess`
 * itself, so the visibility facts this rests on cannot rot unnoticed.
 */
export async function resolveWorkflowAgent(
  agentId: string,
  actor: { id: string; role: string | null | undefined },
  forbiddenMessage = "You do not have access to this agent"
): Promise<WorkflowAgentResult> {
  const gated = await getAgentWithAccess(agentId, actor.id, actor.role ?? "");
  if (gated instanceof NextResponse) return { error: gated };

  if (!canManageAgentWorkflows(gated, actor)) {
    return { error: NextResponse.json({ error: forbiddenMessage }, { status: 403 }) };
  }
  return { agent: gated };
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
