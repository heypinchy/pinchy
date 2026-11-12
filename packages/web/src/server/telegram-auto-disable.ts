import { appendAuditLog, safeProviderError } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { updateTelegramChannelConfig } from "@/lib/openclaw-config";
import { getSetting, setSetting } from "@/lib/settings";
import { clearAllowStoreForAccount } from "@/lib/telegram-allow-store";

/**
 * #477 layer 2: disable a Telegram account that lost a polling conflict, run by
 * the channel-health watchdog. The marker makes the disable survive a restart
 * (build.ts skips the account on regen), the targeted config write stops the
 * poller via the same path connect/disconnect use, and the allow list is
 * cleared. Non-request context — try/catch + recordAuditFailure per AGENTS.md.
 *
 * Once the marker is set the disable has happened as far as Pinchy is
 * concerned, so everything after it runs whichever step fails: the poller only
 * stops once the config lands, and until then the empty list is what keeps the
 * bot from answering anyone. A failed config write is audited, marked failed,
 * and rethrown for the watchdog to log.
 */
export async function autoDisableConflictedTelegramAccount(
  channel: string,
  accountId: string,
  lastError: string,
  resolveAccountName: (channel: string, accountId: string) => Promise<string | null>
): Promise<void> {
  // Defensive: skip if already disabled (e.g. a race with a manual
  // disconnect, or the monitor somehow re-entering for the same episode).
  const already = await getSetting(`telegram_conflict_disabled:${accountId}`);
  if (already) return;

  await setSetting(
    `telegram_conflict_disabled:${accountId}`,
    JSON.stringify({
      reason: "polling_conflict",
      lastError: safeProviderError(lastError),
      disabledAt: new Date().toISOString(),
    })
  );
  let configError: unknown = null;
  try {
    updateTelegramChannelConfig(accountId, null);
  } catch (err) {
    configError = err;
  }
  try {
    await clearAllowStoreForAccount(accountId);
  } catch (err) {
    console.error("[channel-watchdog] failed to clear the allow list:", err);
  }

  const name = await resolveAccountName(channel, accountId);
  const entry = {
    actorType: "system" as const,
    actorId: "channel-watchdog",
    eventType: "channel.auto_disabled" as const,
    resource: `agent:${accountId}`,
    // A fixed message: the error's own can carry a file system path, and the
    // audit row is immutable.
    ...(configError
      ? {
          outcome: "failure" as const,
          error: { message: "Could not remove the bot from the OpenClaw config" },
        }
      : { outcome: "success" as const }),
    detail: {
      channel,
      account: { id: accountId, name },
      reason: "polling_conflict",
      lastError: safeProviderError(lastError),
    },
  };
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }
  if (configError) throw configError;
}
