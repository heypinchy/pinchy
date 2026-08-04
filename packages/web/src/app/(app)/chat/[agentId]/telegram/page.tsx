import type { Metadata } from "next";
import { TelegramChatView } from "@/components/telegram-chat-view";
import { loadChatAgentName, loadChatPageAgent } from "@/lib/chats/load-chat-agent";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  const name = await loadChatAgentName(agentId);
  return { title: name ? `${name} on Telegram` : "Telegram chat" };
}

/**
 * Read-only mirror of the user's Telegram conversation with an agent (#508).
 *
 * The static `telegram` segment wins over the dynamic `[chatId]` segment in
 * Next.js routing (same as `settings`), so `/chat/<id>/<chatId>` is unaffected.
 * Auth gating is literally the base chat page's, via loadChatPageAgent.
 */
export default async function TelegramChatPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const { agent, avatarUrl, canEdit } = await loadChatPageAgent(agentId);

  return (
    <TelegramChatView
      key={agent.id}
      agentId={agent.id}
      agentName={agent.name}
      avatarUrl={avatarUrl}
      isPersonal={agent.isPersonal}
      canEdit={canEdit}
    />
  );
}
