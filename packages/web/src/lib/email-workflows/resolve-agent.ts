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
