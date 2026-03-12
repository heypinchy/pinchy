import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userGroups, agentGroups } from "@/db/schema";

export async function getUserGroupIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.groupId);
}

export async function getAgentGroupIds(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: agentGroups.groupId })
    .from(agentGroups)
    .where(eq(agentGroups.agentId, agentId));
  return rows.map((r) => r.groupId);
}

export async function getAllAgentGroupIds(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ agentId: agentGroups.agentId, groupId: agentGroups.groupId })
    .from(agentGroups);
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.agentId) || [];
    existing.push(row.groupId);
    map.set(row.agentId, existing);
  }
  return map;
}
