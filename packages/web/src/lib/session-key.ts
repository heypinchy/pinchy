/**
 * The OpenClaw session key for a user's direct conversation with an agent.
 *
 * Single source of truth for the formula `agent:{agentId}:direct:{userId}`
 * (optionally suffixed with `:{chatId}` for a named per-chat session, #508).
 * The WS router (`server/client-router.ts`) and any REST route that needs to
 * address the same conversation (e.g. the durable chat-error banner) MUST both
 * derive the key here so they can never drift onto different conversations.
 */
export function directSessionKey(agentId: string, userId: string, chatId?: string): string {
  const base = `agent:${agentId}:direct:${userId}`;
  return chatId ? `${base}:${chatId}` : base;
}
