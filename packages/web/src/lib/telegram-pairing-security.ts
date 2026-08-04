/**
 * Brute-force and abuse controls for `POST /api/settings/telegram` (pairing
 * code redemption).
 *
 * A Telegram pairing code is a short, human-typed string. Without a limit on
 * guesses, a logged-in member can loop codes against a live victim's pending
 * pairing request; a hit writes `channelLinks(userId: attacker, channelUserId:
 * victim's telegram id)`, and `GET /api/agents/[agentId]/telegram-chat`
 * derives its `peerId` from the caller's own `channel_links` row — so a
 * successful guess hands the attacker the victim's full Telegram transcript.
 *
 * Kept out of `route.ts` for the same reason `usage-record-rate-limiter.ts`
 * is a separate module: a Next.js route file may only export HTTP method
 * handlers and well-known config symbols, so any module-level state (the
 * rate-limit counters, the audit throttle windows) and its test-only reset
 * helpers have to live elsewhere.
 */

import { appendAuditLog } from "@/lib/audit";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

// ── Per-user rate limit ─────────────────────────────────────────────────

/**
 * 5 attempts / 10 minutes per authenticated user. Generous enough that a
 * real user mistyping a code twice never sees a 429, tight enough that
 * guessing an 8-character alphanumeric pairing code (OpenClaw's format) is
 * infeasible before the code itself expires (see `PAIRING_CODE_MAX_AGE_MS`
 * in `telegram-pairing.ts`, which uses the same 10-minute window).
 *
 * Keyed per user, not a single global bucket like
 * `usage-record-rate-limiter.ts`: this route is reachable by every member,
 * so a shared bucket would let one attacker's guesses exhaust the budget for
 * everyone else's legitimate pairing attempts. Bounded by the number of
 * distinct users the process has seen, same accepted tradeoff as
 * `scopeDenialWindows` in `lib/api-auth.ts`.
 */
const PAIRING_ATTEMPT_MAX = 5;
const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60_000;

const pairingAttemptLimiters = new Map<string, FixedWindowRateLimiter>();

/** Returns `true` if the user may attempt another pairing-code redemption. */
export function tryAcquireTelegramPairingSlot(userId: string, now: number = Date.now()): boolean {
  let limiter = pairingAttemptLimiters.get(userId);
  if (!limiter) {
    limiter = new FixedWindowRateLimiter({
      max: PAIRING_ATTEMPT_MAX,
      windowMs: PAIRING_ATTEMPT_WINDOW_MS,
    });
    pairingAttemptLimiters.set(userId, limiter);
  }
  return limiter.tryAcquire(now);
}

/** Resets all per-user windows. Intended for tests. */
export function resetTelegramPairingRateLimiterForTest(): void {
  pairingAttemptLimiters.clear();
}

// ── Audit throttle ──────────────────────────────────────────────────────

/**
 * One `auth.telegram_pairing_denied` row per user per minute, with the
 * denials it stood in for counted on the next row rather than dropped. Same
 * shape as `claimScopeDenialSlot` (lib/api-auth.ts) and `claimHostBlockSlot`
 * (server/host-check.ts): worth recording, not worth recording per attempt.
 *
 * The actor here is authenticated (unlike the host-block window, which an
 * anonymous caller can trigger), so keying per user rather than a single
 * global bucket is safe — bounded by users the process has seen.
 */
const PAIRING_FAILURE_AUDIT_WINDOW_MS = 60_000;
const pairingFailureWindows = new Map<string, { openedAt: number; suppressed: number }>();

/** Resets all per-user audit windows. Intended for tests. */
export function resetTelegramPairingAuditWindowsForTest(): void {
  pairingFailureWindows.clear();
}

function claimPairingFailureSlot(
  userId: string,
  now: number
): { write: boolean; suppressed: number } {
  const open = pairingFailureWindows.get(userId);
  if (open && now - open.openedAt < PAIRING_FAILURE_AUDIT_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  pairingFailureWindows.set(userId, { openedAt: now, suppressed: 0 });
  return { write: true, suppressed: open?.suppressed ?? 0 };
}

export type TelegramPairingFailureReason =
  "rate_limited" | "invalid_or_expired_code" | "channel_user_id_conflict";

/**
 * Records a denied Telegram pairing attempt, throttled to one row per user
 * per minute. Awaited (not fire-and-forget) but swallows its own failures —
 * a broken audit DB must never turn a clean 4xx into an unhandled 500.
 */
export async function recordTelegramPairingFailure(
  userId: string,
  reason: TelegramPairingFailureReason,
  now: number = Date.now()
): Promise<void> {
  const slot = claimPairingFailureSlot(userId, now);
  if (!slot.write) return;

  try {
    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "auth.telegram_pairing_denied",
      outcome: "failure",
      error: { message: `Telegram pairing attempt denied: ${reason}` },
      detail: {
        reason,
        ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
      },
    });
  } catch {
    // Don't break the request flow if audit logging fails.
  }
}

// ── Unique-constraint conflict ──────────────────────────────────────────

/**
 * `channel_links` carries two unique indexes (db/schema.ts): one on
 * `(userId, channel)` — the target `POST`'s `onConflictDoUpdate` handles,
 * for re-linking to a different Telegram account — and one on
 * `(channel, channelUserId)`, guarding the reverse direction: one Telegram
 * account cannot be linked to two Pinchy users. The second index isn't an
 * `onConflictDoUpdate` target, so a collision on it still raises a raw
 * Postgres unique-violation (23505) rather than upserting. Duck-typed
 * rather than an `instanceof postgres.PostgresError` check: `PostgresError`
 * is only exposed on a live `sql` connection instance, not as a static
 * export, so a plain-object check is what route/unit tests can construct
 * without a real DB connection too.
 */
export function isChannelUserIdConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const constraintName = (err as { constraint_name?: unknown }).constraint_name;
  return code === "23505" && constraintName === "channel_links_channel_user_id_uniq";
}
