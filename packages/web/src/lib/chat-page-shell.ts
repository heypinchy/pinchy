import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { getAgentAvatarSvg } from "@/lib/avatar";

type ActiveAgent = typeof activeAgents.$inferSelect;

/**
 * The auth/agent-load/visibility preamble shared by every `chat/[agentId]/...`
 * page (the base chat page, the `[chatId]` deep link, and the read-only
 * Telegram mirror): load the session, load the agent, resolve the group-scoped
 * visibility gate, and enforce `assertAgentAccess`. Consolidated so the three
 * page shells can't drift on what "may this user open this agent" means —
 * each page still owns its own `generateMetadata` fallback title, its own
 * post-load behavior (the base page's most-recent-chat redirect), and its own
 * rendered component.
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
  const isAdmin = userRole === "admin";
  const canEdit = isAdmin || (agent.isPersonal && agent.ownerId === userId);

  return { agent, session, avatarUrl, canEdit };
}

/**
 * `generateMetadata` for the same three pages: fetch the agent's name for the
 * tab title and let the caller supply the fallback shape — the base/`[chatId]`
 * pages use a bare "Chat" fallback, the Telegram mirror appends "on Telegram".
 * A NOT FOUND agent here just falls back to the title; this function never
 * calls notFound() (generateMetadata should not 404 the page on its own).
 */
export async function loadChatPageTitle(
  agentId: string,
  formatTitle: (agentName: string | undefined) => string
): Promise<string> {
  const agent = await db
    .select({ name: activeAgents.name })
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);

  return formatTitle(agent?.name);
}

export type { ActiveAgent };
