import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { getUserGroupIds, getAllAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { effectiveVisibility } from "@/lib/agent-access";
import { getInstancePolicy, isPausedPersonalAgent } from "@/lib/instance-policy";

export async function getVisibleAgents(userId: string, userRole: string) {
  const isAdmin = userRole === "admin";
  const licenseState = await getLicenseState();
  // Restricted visibility stays enforced after expiry (fail closed, § 5) —
  // only community instances skip group resolution entirely.
  const needsGroups = !isAdmin && licenseState !== "community";

  const [userGroupIds, allAgents, agentGroupMap] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    db.select().from(activeAgents),
    needsGroups ? getAllAgentGroupIds() : Promise.resolve(new Map<string, string[]>()),
  ]);

  // Read only when it can hide something: a member who owns a personal agent.
  const ownsPersonalAgent = allAgents.some((a) => a.isPersonal && a.ownerId === userId);
  const policy = !isAdmin && ownsPersonalAgent ? await getInstancePolicy() : null;

  const visible: typeof allAgents = [];
  for (const agent of allAgents) {
    // Personal agents are only visible to their owner, regardless of role —
    // and not even to them while members may not use one (Settings →
    // Organization → Member access). The agent stays in the database.
    if (agent.isPersonal) {
      if (agent.ownerId !== userId) continue;
      if (policy && isPausedPersonalAgent(agent, userRole, policy)) continue;
      visible.push(agent);
      continue;
    }
    // Admins see all shared agents
    if (isAdmin) {
      visible.push(agent);
      continue;
    }
    switch (effectiveVisibility(agent.visibility, licenseState)) {
      case "all":
        visible.push(agent);
        break;
      case "restricted": {
        const agentGroupIds = agentGroupMap.get(agent.id) || [];
        if (userGroupIds.some((gId) => agentGroupIds.includes(gId))) {
          visible.push(agent);
        }
        break;
      }
      // unknown visibility — skip (admins-only by default)
    }
  }
  return visible;
}
