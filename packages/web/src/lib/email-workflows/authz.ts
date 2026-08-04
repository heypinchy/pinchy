import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents } from "@/db/schema";

/**
 * The scope rule for creating and managing an agent's email workflows
 * (design §7, #705): a member may act only on a **personal agent they own**; a
 * shared agent — or someone else's personal agent — is admin-only.
 *
 * Single source of truth for every workflow route (create, list, enable/disable,
 * delete), so the boundary can't drift between them. A workflow is standing
 * autonomous authority scoped to one agent, so "may I touch this agent" is the
 * whole question — connection-level checks (create) sit on top of this, not
 * instead of it.
 */
export interface WorkflowAgentScope {
  isPersonal: boolean;
  ownerId: string | null;
}

export function canManageAgentWorkflows(
  agent: WorkflowAgentScope,
  actor: { id: string; role: string | null | undefined }
): boolean {
  if (actor.role === "admin") return true;
  return agent.isPersonal && agent.ownerId === actor.id;
}

export interface ManageableAgent {
  id: string;
  name: string;
  isPersonal: boolean;
  ownerId: string | null;
}

export type AgentScopeCheck =
  { ok: true; agent: ManageableAgent } | { ok: false; response: NextResponse };

/**
 * Load an agent by id and gate it behind canManageAgentWorkflows in one place.
 * Every agentId-keyed workflow route (list, create, the connections picker)
 * shares this: the 404-then-403 shape and the underlying DB read must not
 * drift between copies, because a drifted copy here — one that forgets the
 * ownerId check, or fetches the wrong agent — is a latent authorization bug,
 * not a style nit. `deniedMessage` lets each route keep its own wording for
 * the 403 body without duplicating the check itself.
 */
export async function requireManageableAgent(
  agentId: string,
  actor: { id: string; role: string | null | undefined },
  deniedMessage = "You do not have access to this agent"
): Promise<AgentScopeCheck> {
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
    return {
      ok: false,
      response: NextResponse.json({ error: "Agent not found" }, { status: 404 }),
    };
  }
  if (!canManageAgentWorkflows(agent, actor)) {
    return { ok: false, response: NextResponse.json({ error: deniedMessage }, { status: 403 }) };
  }
  return { ok: true, agent };
}
