import { NextResponse } from "next/server";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";

interface AgentForAccess {
  id: string;
  ownerId: string | null;
  isPersonal: boolean;
  visibility?: string;
}

/**
 * Check if a user has READ access to an agent. Throws if access is denied.
 *
 * Rules:
 * - Admin can access everything
 * - Personal agents are only accessible to their owner
 * - Shared agents check visibility: "all" (everyone), "admin_only" (admins only),
 *   "groups" (only users who share a group with the agent)
 */
export function assertAgentAccess(
  agent: AgentForAccess,
  userId: string,
  userRole: string,
  userGroupIds: string[] = [],
  agentGroupIds: string[] = []
): void {
  if (userRole === "admin") return;
  if (agent.isPersonal) {
    if (agent.ownerId === userId) return;
    throw new Error("Access denied");
  }

  // Shared agent — check visibility
  const visibility = agent.visibility ?? "all";
  switch (visibility) {
    case "all":
      return;
    case "admin_only":
      throw new Error("Access denied");
    case "groups":
      if (userGroupIds.some((gId) => agentGroupIds.includes(gId))) return;
      throw new Error("Access denied");
    default:
      throw new Error("Access denied");
  }
}

/**
 * Check if a user has WRITE access to an agent. Throws if access is denied.
 *
 * Rules:
 * - Admin can modify any agent
 * - Personal agent owners can modify their own agents
 * - Non-admin users CANNOT modify shared agents
 */
export function assertAgentWriteAccess(
  agent: AgentForAccess,
  userId: string,
  userRole: string
): void {
  if (userRole === "admin") return;
  if (agent.isPersonal && agent.ownerId === userId) return;

  throw new Error("Access denied");
}

export async function getAgentWithAccess(agentId: string, userId: string, userRole: string) {
  const rows = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId));
  const agent = rows[0];

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  try {
    assertAgentAccess(agent, userId, userRole);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return agent;
}
