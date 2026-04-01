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
  } catch {
    return { found: false };
  }
}
