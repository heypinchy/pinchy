import { NextResponse } from "next/server";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import type { LicenseState } from "@/lib/license-state";

interface AgentForAccess {
  id: string;
  ownerId: string | null;
  isPersonal: boolean;
  visibility?: string;
}

/**
 * Return the effective visibility for an agent.
 *
 * Fail closed (pricing concept § 5): a license expiry NEVER widens access —
 * "restricted" stays enforced in every licensed and expired state. The single
 * exception is a community instance (never licensed): shared agents default
 * to visibility "restricted" in the DB without anyone having restricted them,
 * so community maps that default to "all" to stay usable.
 */
export function effectiveVisibility(
  dbVisibility: string | undefined,
  licenseState: LicenseState
): string {
  const vis = dbVisibility ?? "all";
  if (licenseState === "community" && vis === "restricted") return "all";
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
 * - Restrictions stay enforced after license expiry (fail closed, § 5);
 *   only community instances treat "restricted" as "all"
 */
export function assertAgentAccess(
  agent: AgentForAccess,
  userId: string,
  userRole: string,
  userGroupIds: string[] = [],
  agentGroupIds: string[] = [],
  licenseState: LicenseState = "paid"
): void {
  // Personal agents are private to their owner — this applies to everyone,
  // including admins. The admin fast-path must NOT bypass this check.
  if (agent.isPersonal) {
    if (agent.ownerId === userId) return;
    throw new Error("Access denied");
  }
  if (userRole === "admin") return;

  // Shared agent — check visibility
  const visibility = effectiveVisibility(agent.visibility, licenseState);
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

/**
 * Same as `assertAgentWriteAccess` but built for API route handlers: returns
 * `null` when the user may write, or a standardized 403 `NextResponse` when
 * they may not. Lets handlers do
 *
 *   const denied = requireAgentWriteAccess(agent, userId, role);
 *   if (denied) return denied;
 *
 * instead of repeating the `try { assertAgentWriteAccess(...) } catch { return 403 }`
 * boilerplate. Mirrors the `getAgentWithAccess` shape (returns
 * `NextResponse | T`).
 */
export function requireAgentWriteAccess(
  agent: AgentForAccess,
  userId: string,
  userRole: string
): NextResponse | null {
  try {
    assertAgentWriteAccess(agent, userId, userRole);
    return null;
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function getAgentWithAccess(agentId: string, userId: string, userRole: string) {
  const rows = await db.select().from(activeAgents).where(eq(activeAgents.id, agentId));
  const agent = rows[0];

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const licenseState = await getLicenseState();
  const effVis = effectiveVisibility(agent.visibility, licenseState);

  // Load group data only when needed (skip for admins and non-restricted)
  const needsGroups = userRole !== "admin" && effVis === "restricted";
  const [userGroupIds, agentGroupIds] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    needsGroups ? getAgentGroupIds(agentId) : Promise.resolve([]),
  ]);

  try {
    assertAgentAccess(agent, userId, userRole, userGroupIds, agentGroupIds, licenseState);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return agent;
}
