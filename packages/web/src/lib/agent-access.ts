import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

interface AgentForAccess {
  id: string;
  ownerId: string | null;
  isPersonal: boolean;
}

/**
 * Check if a user has access to an agent. Throws if access is denied.
 *
 * Rules:
 * - Admin can access everything
 * - Shared agents (isPersonal=false) are accessible to all authenticated users
 * - Personal agents are only accessible to their owner
 */
export function assertAgentAccess(agent: AgentForAccess, userId: string, userRole: string): void {
  if (userRole === "admin") return;
  if (!agent.isPersonal) return;
  if (agent.ownerId === userId) return;

  throw new Error("Access denied");
}

export async function getAgentWithAccess(agentId: string, userId: string, userRole: string) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

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
