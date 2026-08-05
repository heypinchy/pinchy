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
 *
 * **This is a scope rule, not the whole answer, and the difference now matters**
 * (#880). The `agentId`-keyed routes run the VISIBILITY gate in front of it
 * (`resolveWorkflowAgent` → `getAgentWithAccess`), and that gate holds personal
 * agents private to their owner *including admins*. So the "someone else's
 * personal agent is admin-only" leg above is reachable only through
 * `PATCH`/`DELETE /api/automations/[id]`, which is keyed by workflow id and
 * gates on this predicate alone — an admin who already holds a workflow id can
 * still stop a runaway automation, but cannot list or create one on a
 * colleague's private agent. Adding a caller that consults this function
 * WITHOUT a visibility gate re-grants that reach; do it deliberately or not at
 * all.
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
