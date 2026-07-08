import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSettingsByPrefix } from "@/lib/settings";

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
    // Bound the probe so a stalled upstream can't pin the request handler.
    const response = await fetch(`${apiUrl}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
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
 * Point-in-time best-effort probe for a duplicate Telegram poller. Calls
 * getUpdates with a short `timeout` (so it doesn't actually long-poll) and
 * checks whether Telegram signals the "Conflict: terminated by other
 * getUpdates request" it returns when a SECOND deployment is already polling
 * this token. Used at connect-time so Pinchy can reject an obviously
 * already-claimed bot token before writing config and restarting OpenClaw's
 * channel worker (issue #477 layer 1).
 *
 * The conflict is identified by the body's `error_code === 409`, which is the
 * authoritative signal. Real Telegram sets the HTTP status to 409 as well, but
 * we deliberately do NOT gate on the HTTP status: some Telegram-compatible
 * endpoints (and our E2E mock) return the error envelope with a 200 status, so
 * keying off the HTTP status alone would silently miss the conflict.
 *
 * This is intentionally lenient: any outcome other than a confirmed
 * error_code 409 — success, a different error code, a network failure, or a
 * timeout — resolves to `{ conflict: false }`. The probe must never block a
 * legitimate connect because of a transient Telegram/network hiccup; it only
 * catches the clear, unambiguous case. It also cannot detect a conflict that
 * starts up AFTER connect (that's the job of the ongoing channel-health
 * watchdog, a separate concern from this one-shot check).
 */
export async function probeTelegramPollingConflict(token: string): Promise<{ conflict: boolean }> {
  const apiUrl = process.env.TELEGRAM_API_URL || "https://api.telegram.org";
  try {
    // Ask for the SHORTEST possible long-poll (timeout=1s) so the request
    // returns on its own instead of us aborting an in-flight long-poll — an
    // aborted poll can leave the upstream getUpdates connection lingering,
    // which pollutes poll-state that sibling tests observe. Send `timeout` in
    // the POST body: real Telegram and our E2E mock both read it there, a bare
    // query param is not honored by the mock. The AbortSignal is only a
    // stall backstop for a genuinely unresponsive upstream.
    const response = await fetch(`${apiUrl}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await response.json()) as { ok?: boolean; error_code?: number };
    if (data?.ok === false && data.error_code === 409) {
      return { conflict: true };
    }
    return { conflict: false };
  } catch {
    // Network error, timeout, or malformed response — never block a connect
    // on the probe's own failure.
    return { conflict: false };
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
  if (personalAgents.length === 0) return false;

  // Single batched query instead of one getSetting per personal agent (#261).
  const botTokenByKey = await getSettingsByPrefix("telegram_bot_token:");
  return personalAgents.some((agent) =>
    Boolean(botTokenByKey.get(`telegram_bot_token:${agent.id}`))
  );
}
