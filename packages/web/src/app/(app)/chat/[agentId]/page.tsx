import type { Metadata } from "next";
import { db } from "@/db";
import { activeAgents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { Chat } from "@/components/chat";
import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess, effectiveVisibility } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import { getLicenseState } from "@/lib/enterprise";
import { getAgentAvatarSvg } from "@/lib/avatar";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyUserSessions, type RawSession } from "@/lib/chats/classify-sessions";
import { selectMostRecentWebChatId } from "@/lib/chats/select-most-recent-chat";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  const agent = await db
    .select({ name: activeAgents.name })
    .from(activeAgents)
    .where(eq(activeAgents.id, agentId))
    .then((rows) => rows[0]);

  return { title: agent?.name ?? "Chat" };
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams?: Promise<{ keep?: string }>;
}) {
  const { agentId } = await params;
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

  // Where should a bare /chat/<agentId> land? (#508) The user's most-recently-
  // interacted chat — the sidebar links here when this device has no recorded
  // last-viewed chat. The switcher opens the legacy/default chat explicitly with
  // `?keep`, which skips the redirect so that chat stays reachable.
  const sp = searchParams ? await searchParams : {};
  let mostRecentChatId: string | null = null;
  if (sp.keep === undefined) {
    try {
      const raw = (await getOpenClawClient().sessions.list({})) as
        { sessions?: RawSession[] } | undefined;
      const sessionsArr = Array.isArray(raw?.sessions) ? raw.sessions : [];
      const scoped = sessionsArr.filter(
        (s) => typeof s?.key === "string" && s.key.split(":")[1] === agentId
      );
      // Only web chats are a valid landing target, so no Telegram peers needed.
      const classified = classifyUserSessions(scoped, userId, new Set());
      mostRecentChatId = selectMostRecentWebChatId(classified);
    } catch {
      // OpenClaw unreachable — render the default chat rather than failing.
      mostRecentChatId = null;
    }
  }
  // redirect() throws NEXT_REDIRECT, so it must run OUTSIDE the try/catch above.
  if (mostRecentChatId) redirect(`/chat/${agentId}/${mostRecentChatId}`);

  const avatarUrl = getAgentAvatarSvg({ avatarSeed: agent.avatarSeed, name: agent.name });
  const isAdmin = userRole === "admin";
  const canEdit = isAdmin || (agent.isPersonal && agent.ownerId === userId);

  return (
    <Chat
      key={agent.id}
      agentId={agent.id}
      agentName={agent.name}
      isPersonal={agent.isPersonal}
      avatarUrl={avatarUrl}
      canEdit={canEdit}
    />
  );
}
