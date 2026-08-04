import { readFileSync, existsSync } from "fs";

const PAIRING_FILE_PATH =
  process.env.OPENCLAW_PAIRING_PATH || "/openclaw-config/credentials/telegram-pairing.json";

/**
 * Pairing codes are short, human-typed strings OpenClaw writes to the shared
 * pairing file and never expires or removes on its own — an unredeemed
 * request just accumulates. Without a cutoff here, a code stays guessable
 * forever, widening the brute-force window on `POST /api/settings/telegram`
 * without limit. 10 minutes matches that route's own rate-limit window
 * (`telegram-pairing-security.ts`), so a code that survives the attempt
 * budget also survives its own expiry, and vice versa.
 */
const PAIRING_CODE_MAX_AGE_MS = 10 * 60_000;

interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
}

interface PairingFile {
  version: number;
  requests: PairingRequest[];
}

type PairingResult = { found: true; telegramUserId: string } | { found: false };

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

    // Fail closed on a missing/unparseable createdAt: expiry is a security
    // control, so an entry we can't date is treated as already expired
    // rather than as unexpiring.
    const createdAtMs = Date.parse(match.createdAt);
    if (Number.isNaN(createdAtMs) || now - createdAtMs >= PAIRING_CODE_MAX_AGE_MS) {
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
