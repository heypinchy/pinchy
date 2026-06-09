/**
 * Channel-health classification (issue: silent cross-environment Telegram
 * getUpdates-409 conflict — A-1/A-2).
 *
 * OpenClaw owns the channel pollers (Telegram, Slack, …); when a second
 * deployment polls the same bot token, Telegram returns 409 and OpenClaw's
 * channel worker enters a CPU-burning auto-restart loop. That degradation is
 * invisible to Pinchy at the gateway-WebSocket level — but it IS exposed in
 * `client.channels.status()`. `classifyChannelStatus` turns that raw, opaque
 * payload into per-account health verdicts the watchdog can act on.
 *
 * The shape (`channelAccounts.<channel>[]` with `connected` / `running` /
 * `lastError` / `restartPending` / `reconnectAttempts`) was captured from live
 * OpenClaw 2026.6.1 — see channel-health.fixtures.ts. The parsing is
 * deliberately defensive: the payload is typed `Record<string, unknown>` by
 * openclaw-node, so a field rename upstream degrades to "treat as degraded /
 * default safely" rather than throwing.
 */

export interface ChannelAccountHealth {
  /** Channel family, e.g. "telegram", "slack". */
  channel: string;
  /** Per-account id (a Pinchy agent id for Telegram bot accounts). */
  accountId: string;
  state: "healthy" | "degraded";
  connected: boolean;
  running: boolean;
  /** Non-null when the worker last exited with an error (e.g. the 409 text). */
  lastError: string | null;
  reconnectAttempts: number;
  restartPending: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Classify every ENABLED + CONFIGURED channel account in an OpenClaw
 * `channels.status()` payload. Disabled/unconfigured accounts are skipped —
 * being off is intentional, not a failure. Returns `[]` for any malformed or
 * empty payload.
 *
 * Healthy ⇔ `connected && running && lastError == null`. Anything else
 * (not connected, worker stopped, a lingering error, a pending/looping
 * restart) is `degraded`. Escalation to a terminal "polling failed" state is
 * the watchdog's job (it tracks how long an account stays degraded), not this
 * pure per-snapshot classifier.
 */
export function classifyChannelStatus(status: unknown): ChannelAccountHealth[] {
  const root = asRecord(status);
  if (!root) return [];
  const channelAccounts = asRecord(root.channelAccounts);
  if (!channelAccounts) return [];

  const out: ChannelAccountHealth[] = [];
  for (const [channel, accounts] of Object.entries(channelAccounts)) {
    if (!Array.isArray(accounts)) continue;
    for (const raw of accounts) {
      const a = asRecord(raw);
      if (!a) continue;
      const accountId = typeof a.accountId === "string" ? a.accountId : null;
      if (!accountId) continue;

      // Default-on: only an explicit `false` means intentionally disabled.
      const enabled = a.enabled !== false;
      const configured = a.configured !== false;
      if (!enabled || !configured) continue;

      const connected = a.connected === true;
      const running = a.running === true;
      const lastError =
        typeof a.lastError === "string" && a.lastError.length > 0 ? a.lastError : null;
      const reconnectAttempts =
        typeof a.reconnectAttempts === "number" && Number.isFinite(a.reconnectAttempts)
          ? a.reconnectAttempts
          : 0;
      const restartPending = a.restartPending === true;

      const healthy = connected && running && lastError === null;
      out.push({
        channel,
        accountId,
        state: healthy ? "healthy" : "degraded",
        connected,
        running,
        lastError,
        reconnectAttempts,
        restartPending,
      });
    }
  }
  return out;
}
