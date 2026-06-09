/**
 * Real `channels.status()` payloads captured from OpenClaw 2026.6.1 against the
 * telegram-mock during a getUpdates-409 duplicate-poller conflict (the exact
 * production failure behind the silent 125%-CPU restart loop). Captured via the
 * PINCHY_CH_CAPTURE spike on 2026-06-09 — see the channel-health feature notes.
 *
 * These are trimmed but structurally faithful to the live payloads so the
 * classifier is tested against ground truth, not a guess at the shape.
 */

const ACCOUNT_ID = "29ea51b1-67af-4fad-8864-f550c7543333";

/** A healthy, polling telegram account (connected, no error). */
export function healthyTelegramStatus() {
  return {
    ts: 1781005438083,
    channelOrder: ["telegram"],
    channelLabels: { telegram: "Telegram" },
    channelMeta: [{ id: "telegram", label: "Telegram", detailLabel: "Telegram Bot" }],
    eventLoop: { degraded: false, reasons: [], intervalMs: 1604 },
    channels: {
      telegram: {
        configured: true,
        running: true,
        lastStartAt: 1781005392346,
        lastStopAt: null,
        lastError: null,
        tokenSource: "config",
        mode: "polling",
      },
    },
    channelAccounts: {
      telegram: [
        {
          accountId: ACCOUNT_ID,
          enabled: true,
          configured: true,
          running: true,
          lastStartAt: 1781005392346,
          lastStopAt: null,
          lastError: null,
          connected: true,
          restartPending: false,
          reconnectAttempts: 0,
          lastConnectedAt: 1781005422862,
          tokenSource: "config",
          tokenStatus: "available",
          mode: "polling",
          allowUnmentionedGroups: false,
        },
      ],
    },
    channelDefaultAccountId: { telegram: ACCOUNT_ID },
  };
}

/**
 * The same account mid-conflict: the worker exited on the 409, OpenClaw is
 * auto-restarting it (attempt N/10), so it is not connected, carries the
 * conflict lastError, and reconnectAttempts is climbing.
 */
export function degradedTelegramStatus(reconnectAttempts = 2) {
  const s = healthyTelegramStatus();
  Object.assign(s.channels.telegram, {
    running: false,
    lastStopAt: 1781005458151,
    lastError:
      "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running | Telegram ingress worker exited with code 1",
  });
  Object.assign(s.channelAccounts.telegram[0], {
    running: false,
    lastStopAt: 1781005458151,
    lastError:
      "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running | Telegram ingress worker exited with code 1",
    connected: false,
    restartPending: true,
    reconnectAttempts,
    healthState: "not-running",
  });
  return s;
}

export const TELEGRAM_ACCOUNT_ID = ACCOUNT_ID;
export const CONFLICT_ERROR =
  "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running | Telegram ingress worker exited with code 1";
