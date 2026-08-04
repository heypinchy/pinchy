import { z } from "zod";

/**
 * `POST /api/settings/telegram` — redeem a pairing code. Shared with
 * `telegram-link-settings.tsx` (AGENTS.md § "Shared Schemas And Typed Client").
 */
export const linkTelegramSchema = z.object({ code: z.string().min(1) });
export type LinkTelegramInput = z.infer<typeof linkTelegramSchema>;

/**
 * `POST /api/agents/[agentId]/channels/telegram` — connect an agent's bot.
 * Shared with `agent-telegram-settings.tsx`.
 */
export const setBotTokenSchema = z.object({
  botToken: z.string().min(1),
});
export type SetBotTokenInput = z.infer<typeof setBotTokenSchema>;
