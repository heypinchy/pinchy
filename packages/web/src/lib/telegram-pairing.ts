import {
  callPairingStore,
  OpenClawNotConnectedError,
  PAIRING_FIND_BY_CODE_METHOD,
} from "@/lib/openclaw-pairing-store";

/**
 * How long a pairing code stays redeemable — measured from the peer's last
 * contact with the bot (`lastSeenAt`), NOT from `createdAt`.
 *
 * Pairing codes are short, human-typed strings. OpenClaw drops a pending
 * request only after its own one-hour TTL (`PAIRING_PENDING_TTL_MS` in
 * openclaw's `pairing-store`), and keeps up to three pending requests per bot
 * account, so without a cutoff here a code stays guessable for a full hour —
 * far longer than the attempt budget `telegram-pairing-security.ts` is sized
 * against.
 *
 * The choice of `lastSeenAt` over `createdAt` is forced by that same store.
 * `upsertChannelPairingRequest` keeps the ORIGINAL `createdAt` (and hands back
 * the SAME code) for every further message from a peer whose request is still
 * pending; only `lastSeenAt` moves. So a `createdAt`-based cutoff would turn
 * this route's own advice — "Send a new message to the bot and try again" —
 * into a dead end: the new message returns the same, still-expired code, and
 * the user stays locked out of a self-service flow until OpenClaw's hour is
 * up. Keyed on `lastSeenAt` the advice works, while the window a guesser gets
 * stays bounded by the victim's own last contact with the bot and by
 * OpenClaw's one-hour TTL on top. 10 minutes matches the per-user attempt
 * budget in `telegram-pairing-security.ts`.
 */
const PAIRING_CODE_MAX_AGE_MS = 10 * 60_000;

interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
  /**
   * Bumped by OpenClaw on every message from that peer while the request is
   * pending. A request written by an older OpenClaw may predate it, and the
   * store keeps such rows as they were imported: `createdAt` is the
   * documented fallback (openclaw's own `resolveLastSeenAt` does the same).
   */
  lastSeenAt?: string;
}

/**
 * `unavailable` means the lookup itself failed, so nothing is known about the
 * code: the caller must not tell the user their code was wrong.
 */
type PairingResult = { found: true; telegramUserId: string } | { found: false; unavailable?: true };

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * When the peer last contacted the bot, in epoch ms — `null` when neither
 * timestamp can be read.
 */
function resolveLastContactMs(request: PairingRequest): number | null {
  return parseTimestamp(request.lastSeenAt) ?? parseTimestamp(request.createdAt);
}

/**
 * Resolve a pairing code to a Telegram user ID by asking OpenClaw's pairing
 * store (through the pinchy-audit plugin) for the pending request.
 *
 * `now` defaults to `Date.now()` and exists so tests can drive expiry
 * deterministically without mocking the system clock.
 */
export async function resolvePairingCode(
  code: string,
  now: number = Date.now()
): Promise<PairingResult> {
  let match: PairingRequest | null;
  try {
    const answer = await callPairingStore(PAIRING_FIND_BY_CODE_METHOD, { code: code.trim() });
    match = (answer.request as PairingRequest | null | undefined) ?? null;
  } catch (err) {
    // Log loudly: a bare catch once turned an unreadable pairing file into a
    // misleading "Invalid pairing code" on staging (v0.5.0). A disconnected
    // gateway is ordinary during a restart and needs no warning.
    if (!(err instanceof OpenClawNotConnectedError)) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[telegram-pairing] failed to look up pairing code:", message);
    }
    return { found: false, unavailable: true };
  }
  if (!match) return { found: false };

  // Fail closed on an entry with no readable timestamp at all: expiry is a
  // security control, so an entry we can't date is treated as already
  // expired rather than as unexpiring.
  const lastContactMs = resolveLastContactMs(match);
  if (lastContactMs === null || now - lastContactMs >= PAIRING_CODE_MAX_AGE_MS) {
    return { found: false };
  }

  return { found: true, telegramUserId: match.id };
}
