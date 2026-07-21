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
