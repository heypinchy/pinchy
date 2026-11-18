import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

/**
 * Rewrite the Telegram allow lists in OpenClaw's store, run from server.ts's
 * `connected` handler on every connect.
 *
 * The lists live in OpenClaw's state database since 2026.9, and Pinchy can
 * write them only over a live connection: a change made while OpenClaw was
 * away was skipped, and an install coming from an older OpenClaw has its lists
 * imported from files Pinchy no longer maintains. The recalculation rebuilds
 * every list from the database, so one run settles both. A failure is logged;
 * the allow store tries the run again on its own.
 */
export async function syncTelegramAllowStoresOnConnect(
  recalculate: () => Promise<void> = recalculateTelegramAllowStores
): Promise<void> {
  try {
    await recalculate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      "[telegram-allow-store]",
      "failed to sync the allow lists after connecting:",
      message
    );
  }
}
