import { NextResponse } from "next/server";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { isEnterprise } from "@/lib/enterprise";

interface AgentForAccess {
  id: string;
  ownerId: string | null;
  isPersonal: boolean;
  visibility?: string;
}

/**
 * Return the effective visibility for an agent.
 * When enterprise features are disabled, "restricted" falls back to "all"
 * so no users lose access after an enterprise key expires.
 */
export function effectiveVisibility(dbVisibility: string | undefined, enterprise: boolean): string {
  const vis = dbVisibility ?? "all";
  if (!enterprise && vis === "restricted") return "all";
  return vis;
}

/**
 * Check if a user has READ access to an agent. Throws if access is denied.
 *
 * Rules:
 * - Admin can access everything
 * - Personal agents are only accessible to their owner
 * - Shared agents check visibility: "all" (everyone), "restricted" (only users
 *   who share a group with the agent; if no groups assigned, admins only)
 * - When enterprise=false, "restricted" is treated as "all" (graceful degradation)
 */
export function assertAgentAccess(
  agent: AgentForAccess,
  userId: string,
  userRole: string,
  userGroupIds: string[] = [],
  agentGroupIds: string[] = [],
  enterprise: boolean = true
): void {
  if (userRole === "admin") return;
  if (agent.isPersonal) {
    if (agent.ownerId === userId) return;
    throw new Error("Access denied");
  }

  // Shared agent — check visibility
  const visibility = effectiveVisibility(agent.visibility, enterprise);
  switch (visibility) {
    case "all":
      return;
    case "restricted":
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

  const enterprise = await isEnterprise();
  const effVis = effectiveVisibility(agent.visibility, enterprise);

  // Load group data only when needed (skip for admins, non-restricted, or non-enterprise)
  const needsGroups = userRole !== "admin" && effVis === "restricted";
  const [userGroupIds, agentGroupIds] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    needsGroups ? getAgentGroupIds(agentId) : Promise.resolve([]),
  ]);

  try {
    assertAgentAccess(agent, userId, userRole, userGroupIds, agentGroupIds, enterprise);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return agent;
}
