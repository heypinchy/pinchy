import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Chat } from "@/components/chat";
import { loadChatAgentName, loadChatPageAgent } from "@/lib/chats/load-chat-agent";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyUserSessions, type RawSession } from "@/lib/chats/classify-sessions";
import { selectMostRecentWebChatId } from "@/lib/chats/select-most-recent-chat";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  return { title: (await loadChatAgentName(agentId)) ?? "Chat" };
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams?: Promise<{ keep?: string }>;
}) {
  const { agentId } = await params;
  const { agent, userId, avatarUrl, canEdit } = await loadChatPageAgent(agentId);

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
