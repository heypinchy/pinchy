import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";

export async function getVisibleAgents(userId: string, userRole: string) {
  if (userRole === "admin") {
    return db.select().from(activeAgents);
  }

  const userGroupIds = await getUserGroupIds(userId);
  const allAgents = await db.select().from(activeAgents);

  const visible: typeof allAgents = [];
  for (const agent of allAgents) {
    if (agent.isPersonal) {
      if (agent.ownerId === userId) visible.push(agent);
      continue;
    }
    switch (agent.visibility) {
      case "all":
        visible.push(agent);
        break;
      case "groups": {
        const agentGroupIds = await getAgentGroupIds(agent.id);
        if (userGroupIds.some((gId) => agentGroupIds.includes(gId))) {
          visible.push(agent);
        }
        break;
      }
      // "admin_only" — skip
    }
  }
  return visible;
}
