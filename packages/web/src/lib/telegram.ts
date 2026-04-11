import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSetting } from "@/lib/settings";

interface TelegramValidationSuccess {
  valid: true;
  botId: number;
  botUsername: string;
}

interface TelegramValidationFailure {
  valid: false;
  error: string;
}

export type TelegramValidationResult = TelegramValidationSuccess | TelegramValidationFailure;

export async function validateTelegramBotToken(token: string): Promise<TelegramValidationResult> {
  const apiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  try {
    const response = await fetch(`${apiUrl}/bot${token}/getMe`);
    const data = await response.json();

    if (!data.ok) {
      return { valid: false, error: data.description || "Invalid token" };
    }

    return {
      valid: true,
      botId: data.result.id,
      botUsername: data.result.username,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * True when Pinchy's main Telegram bot is configured — i.e. when at least
 * one personal agent (Smithers) has a bot token set. Used as a precondition
 * for per-agent Telegram bot setup: users can only pair via the main bot,
 * so additional agent bots are unreachable without one.
 */
export async function hasMainTelegramBot(): Promise<boolean> {
  const personalAgents = await db.query.agents.findMany({
    where: eq(agents.isPersonal, true),
    columns: { id: true },
  });
  for (const agent of personalAgents) {
    const token = await getSetting(`telegram_bot_token:${agent.id}`);
    if (token) return true;
  }
  return false;
}
