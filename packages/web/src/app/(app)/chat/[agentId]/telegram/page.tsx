import type { Metadata } from "next";
import { TelegramChatView } from "@/components/telegram-chat-view";
import { loadChatPageAgent, loadChatPageTitle } from "@/lib/chat-page-shell";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  return {
    title: await loadChatPageTitle(agentId, (name) =>
      name ? `${name} on Telegram` : "Telegram chat"
    ),
  };
}

/**
 * Read-only mirror of the user's Telegram conversation with an agent (#508).
 *
 * The static `telegram` segment wins over the dynamic `[chatId]` segment in
 * Next.js routing (same as `settings`), so `/chat/<id>/<chatId>` is unaffected.
 * Auth gating mirrors the base `chat/[agentId]/page.tsx`.
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
