import { count, and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, groups } from "@/db/schema";

const RESTRICTED_SHARED_AGENTS = and(
  eq(agents.visibility, "restricted"),
  eq(agents.isPersonal, false),
  isNull(agents.deletedAt)
);

/**
 * Whether any license-gated configuration exists: groups, or shared agents
 * with restricted visibility. Used to decide if the "Remove all
 * license-gated configuration" escape hatch (pricing concept § 5) applies.
 */
export async function hasGatedConfig(): Promise<boolean> {
  const [groupRows, restrictedAgentRows] = await Promise.all([
    db.select({ count: count() }).from(groups),
    db.select({ count: count() }).from(agents).where(RESTRICTED_SHARED_AGENTS),
  ]);
  return groupRows[0].count > 0 || restrictedAgentRows[0].count > 0;
}

export interface RemovedGatedConfig {
  groups: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
}

/**
 * The "Remove all license-gated configuration" escape hatch (pricing concept
 * § 5, carve-out 2): deletes all groups (memberships and agent links cascade)
 * and resets restricted shared agents to be visible to all users — back to
 * community semantics. Deliberately widens access, which is why it only runs
 * as an explicit, audited admin action.
 *
 * Returns name snapshots for the audit entry — the rows are gone afterwards.
 */
export async function removeGatedConfig(): Promise<RemovedGatedConfig> {
  const [allGroups, restrictedAgents] = await Promise.all([
    db.select({ id: groups.id, name: groups.name }).from(groups),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(RESTRICTED_SHARED_AGENTS),
  ]);

  if (allGroups.length > 0) {
    await db.delete(groups);
  }
  if (restrictedAgents.length > 0) {
    await db.update(agents).set({ visibility: "all" }).where(RESTRICTED_SHARED_AGENTS);
  }

  return { groups: allGroups, agents: restrictedAgents };
}
