import type { Metadata } from "next";
import { Chat } from "@/components/chat";
import { loadChatPageAgent, loadChatPageTitle } from "@/lib/chat-page-shell";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string; chatId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  return { title: await loadChatPageTitle(agentId, (name) => name ?? "Chat") };
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ agentId: string; chatId: string }>;
}) {
  const { agentId, chatId } = await params;
  const { agent, avatarUrl, canEdit } = await loadChatPageAgent(agentId);

  return (
    <Chat
      // Keying on (agentId, chatId) (#508) remounts <Chat> on a chat switch so
      // the runtime reconnects to the new session with no stale-message bleed.
      key={`${agent.id}:${chatId}`}
      agentId={agent.id}
      chatId={chatId}
      agentName={agent.name}
      isPersonal={agent.isPersonal}
      avatarUrl={avatarUrl}
      canEdit={canEdit}
    />
  );
}
