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

/**
 * The OpenClaw session key for one isolated Inbox-Agent run (#139).
 *
 * Keyed by the `processed_emails` ledger row so run ↔ ledger correlation is
 * one string comparison, and deliberately NOT in the `:direct:` namespace —
 * chat listing keys on `:direct:`, so an inbox run can never surface as a user
 * conversation. Sessions in this namespace are throwaway: OpenClaw's daily
 * session reset garbage-collects them.
 */
export function inboxSessionKey(agentId: string, ledgerId: string): string {
  return `agent:${agentId}:inbox:${ledgerId}`;
}
