import { and, asc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentGroups } from "@/db/schema";

export interface AgentRef {
  id: string;
  name: string;
}

/**
 * Shared agents stored as `restricted` with no group attached (#1278).
 *
 * That is the DB default for every new shared agent, so on a community
 * instance — where `effectiveVisibility` reads `restricted` as `all` — almost
 * every shared agent matches without anyone having chosen it. The moment a
 * license is active, the same row means "only admins can use this agent", and
 * every member loses it at once. This is the set an admin has to see before
 * and after that moment.
 *
 * Built as a function, not a constant, so the correlated subquery is created
 * per call against the outer `agents` reference.
 */
function adminOnlySharedAgents() {
  return and(
    eq(agents.visibility, "restricted"),
    eq(agents.isPersonal, false),
    isNull(agents.deletedAt),
    notExists(
      db
        .select({ agentId: agentGroups.agentId })
        .from(agentGroups)
        .where(eq(agentGroups.agentId, agents.id))
    )
  );
}

/** Shared agents only admins can use under a license, sorted by name. */
export async function listAdminOnlyAgents(): Promise<AgentRef[]> {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(adminOnlySharedAgents())
    .orderBy(asc(agents.name), asc(agents.id));
}

/**
 * Make the named admin-only agents visible to everyone — the explicit,
 * audited admin action that restores what members saw before the license.
 *
 * The admin-only condition is re-checked inside the UPDATE, so an agent that
 * got a group (or went personal, or was deleted) after the list was shown is
 * left alone. Widening a group-scoped agent to everyone is exactly the silent
 * change this action must never make.
 *
 * Returns the rows that actually changed, with names for the audit entry.
 */
export async function openAdminOnlyAgentsToAll(agentIds: string[]): Promise<AgentRef[]> {
  if (agentIds.length === 0) return [];
  return db
    .update(agents)
    .set({ visibility: "all" })
    .where(and(inArray(agents.id, agentIds), adminOnlySharedAgents()))
    .returning({ id: agents.id, name: agents.name });
}
