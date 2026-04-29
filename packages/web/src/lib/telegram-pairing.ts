import { readFileSync, existsSync } from "fs";

const PAIRING_FILE_PATH =
  process.env.OPENCLAW_PAIRING_PATH || "/openclaw-config/credentials/telegram-pairing.json";

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
 */
export function resolvePairingCode(code: string): PairingResult {
  if (!existsSync(PAIRING_FILE_PATH)) {
    return { found: false };
  }

  try {
    const data: PairingFile = JSON.parse(readFileSync(PAIRING_FILE_PATH, "utf-8"));
    const normalizedCode = code.trim().toUpperCase();

    const match = data.requests.find((r) => String(r.code ?? "").toUpperCase() === normalizedCode);

    if (!match) return { found: false };

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
