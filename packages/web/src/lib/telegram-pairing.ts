import { readFileSync, existsSync } from "fs";

const PAIRING_FILE_PATH =
  process.env.OPENCLAW_PAIRING_PATH || "/openclaw-config/credentials/telegram-pairing.json";

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
   * pending. Optional here because a file written by an older OpenClaw may
   * predate the field — `createdAt` is the documented fallback (openclaw's
   * own `resolveLastSeenAt` does the same).
   */
  lastSeenAt?: string;
}

interface PairingFile {
  version: number;
  requests: PairingRequest[];
}

type PairingResult = { found: true; telegramUserId: string } | { found: false };

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
 * Resolve a pairing code to a Telegram user ID by reading OpenClaw's
 * pairing request file directly from the shared volume.
 *
 * `now` defaults to `Date.now()` and exists so tests can drive expiry
 * deterministically without mocking the system clock.
 */
export function resolvePairingCode(code: string, now: number = Date.now()): PairingResult {
  if (!existsSync(PAIRING_FILE_PATH)) {
    return { found: false };
  }

  try {
    const data: PairingFile = JSON.parse(readFileSync(PAIRING_FILE_PATH, "utf-8"));
    const normalizedCode = code.trim().toUpperCase();

    const match = data.requests.find((r) => String(r.code ?? "").toUpperCase() === normalizedCode);

    if (!match) return { found: false };

    // Fail closed on an entry with no readable timestamp at all: expiry is a
    // security control, so an entry we can't date is treated as already
    // expired rather than as unexpiring.
    const lastContactMs = resolveLastContactMs(match);
    if (lastContactMs === null || now - lastContactMs >= PAIRING_CODE_MAX_AGE_MS) {
      return { found: false };
    }

    return { found: true, telegramUserId: match.id };
  } catch (err) {
    // Log non-ENOENT errors loudly. The default bare-catch swallowed EACCES
    // on v0.5.0 staging (file written root:0600 by OpenClaw, Pinchy uid 999
    // can't read it) which surfaced as a misleading "Invalid pairing code"
    // to the user — the file existed but was unreadable, not missing. ENOENT
    // is filtered out because cold start (file not yet written) is normal.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[telegram-pairing] failed to read pairing file:", message);
    }
    return { found: false };
  }
}
