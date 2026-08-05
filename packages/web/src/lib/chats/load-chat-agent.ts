import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { getAgentAvatarSvg } from "@/lib/avatar";

/**
 * The agent name a chat route's `generateMetadata` puts in the tab title.
 *
 * Deliberately unauthenticated: `generateMetadata` runs before (and
 * independently of) the page body, and Next.js gives it no way to answer 404 —
 * so the gate lives in the page, and the callers already fall back to a generic
 * title when this returns undefined. An agent's display name is not the secret
 * here; its contents are, and those never load without `loadChatPageAgent`.
 */
export async function loadChatAgentName(agentId: string): Promise<string | undefined> {
  const agent = await db
    .select({ name: activeAgents.name })
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);
  return agent?.name;
}

/**
 * Load an agent for a chat page, or answer 404 — the auth → load → visibility
 * preamble that every chat route opens with (`/chat/[agentId]`, its
 * `[chatId]` child, and the read-only `telegram` mirror).
 *
 * Single-sourced because all three carried it byte-identically (#1087). Like
 * the Automations gate, the risk is not a cosmetic difference: this block
 * decides who may read an agent's conversations, and the realistic drift is a
 * new condition (a license state, a group rule) landing in two of three copies.
 *
 * `notFound()` throws, so it escapes to Next.js from here exactly as it did
 * inline — including for a denied `assertAgentAccess`, which stays a 404 rather
 * than a 403 on purpose: a member who cannot see an agent should not learn that
 * it exists.
 *
 * The Automations gate (`resolveWorkflowAgent`) answers 403 for its refusals,
 * which looks like the opposite call. It gates *manage scope*, not visibility,
 * so its ordinary refusal is an agent the member demonstrably can see — the
 * reasoning, and the one leg left knowingly open, are on that function.
 *
 * Group ids are fetched only when they can change the answer (a non-admin
 * hitting a restricted agent), which is what keeps the common case at one
 * query.
 */
export async function loadChatPageAgent(agentId: string) {
  const session = await requireAuth();
  const userId = session.user.id!;
  const userRole = session.user.role;

  const agent = await db
    .select()
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);

  if (!agent) notFound();

  const licenseState = await getLicenseState();
  const effVis = effectiveVisibility(agent.visibility, licenseState);
  const needsGroups = userRole !== "admin" && effVis === "restricted";

  const [userGroupIds, agentGroupIds] = await Promise.all([
    needsGroups ? getUserGroupIds(userId) : Promise.resolve([]),
    needsGroups ? getAgentGroupIds(agentId) : Promise.resolve([]),
  ]);

  try {
    assertAgentAccess(agent, userId, userRole, userGroupIds, agentGroupIds, licenseState);
  } catch {
    notFound();
  }

  const avatarUrl = getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name });
  const canEdit = userRole === "admin" || (agent.isPersonal && agent.ownerId === userId);

  return { agent, userId, userRole, avatarUrl, canEdit };
}
