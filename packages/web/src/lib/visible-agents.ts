import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { getUserGroupIds, getAllAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";
import { effectiveVisibility } from "@/lib/agent-access";

export async function getVisibleAgents(userId: string, userRole: string) {
  const isAdmin = userRole === "admin";
  const enterprise = await isEnterprise();
  const needsGroups = !isAdmin && enterprise;

  const [userGroupIds, allAgents, agentGroupMap] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    db.select().from(activeAgents),
    needsGroups ? getAllAgentGroupIds() : Promise.resolve(new Map<string, string[]>()),
  ]);

  const visible: typeof allAgents = [];
  for (const agent of allAgents) {
    // Personal agents are only visible to their owner, regardless of role
    if (agent.isPersonal) {
      if (agent.ownerId === userId) visible.push(agent);
      continue;
    }
    // Admins see all shared agents
    if (isAdmin) {
      visible.push(agent);
      continue;
    }
    switch (effectiveVisibility(agent.visibility, enterprise)) {
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
