/**
 * Conflict-restart handler (#477 layer 3) — the server-side implementation
 * behind the channel-health watchdog's `restartConflictedAccount` dep.
 *
 * Since OpenClaw's isolated-ingress rework, a Telegram getUpdates-409 tears
 * the polling worker down and reschedules it on an exponential backoff that
 * compounds to 10 minutes, with `lastError` left stale while it sleeps — so a
 * bot whose conflict has long cleared can stay dark for many minutes (or, for
 * a recently-added bot, get auto-disabled off that stale evidence). This
 * handler bounces the single affected account through the gateway's
 * runtime-only `channels.stop` / `channels.start` RPCs: a fresh polling
 * session starts with a fresh backoff, so recovery lands within one watchdog
 * cycle of the conflict clearing — independent of OpenClaw's internal pacing.
 * Neither RPC persists anything to openclaw.json (unlike `channels.logout`),
 * so Pinchy's config ownership is untouched.
 *
 * Every attempt is audited as `channel.restarted` (outcome success/failure).
 * Never throws — the watchdog tick must survive a gateway hiccup.
 */
import { safeProviderError } from "@/lib/audit";

interface GatewayResponse {
  ok: boolean;
  error?: { code?: string; message?: string };
}

export interface ChannelRestartAuditPayload {
  actorType: "system";
  actorId: "channel-watchdog";
  eventType: "channel.restarted";
  resource: string;
  outcome: "success" | "failure";
  detail: {
    channel: string;
    account: { id: string; name: string | null };
    reason: "polling_conflict";
    lastError: string | null;
    restartAttempt: number;
    error?: string;
  };
}

export interface ConflictRestartDeps {
  /** Raw gateway RPC (openclaw-node `client.request`). Resolves with `ok:false` on gateway-side errors, rejects on timeout/disconnect. */
  request: (method: string, params: Record<string, unknown>) => Promise<GatewayResponse>;
  /** True when auto-disable (#477 layer 2) already disabled this account — restarting it would fight the disable. */
  isConflictDisabled: (accountId: string) => Promise<boolean>;
  resolveAccountName: (channel: string, accountId: string) => Promise<string | null>;
  /** Audit sink; the caller owns failure handling (recordAuditFailure). */
  writeAudit: (entry: ChannelRestartAuditPayload) => Promise<void>;
}

export function createConflictRestartHandler(deps: ConflictRestartDeps) {
  return async function restartConflictedAccount(
    channel: string,
    accountId: string,
    lastError: string,
    attempt: number
  ): Promise<void> {
    try {
      if (await deps.isConflictDisabled(accountId)) return;
    } catch {
      // Unknown disable state — restarting a disabled account is a no-op on
      // the gateway side (the account is gone from config), so proceed.
    }

    // A failing stop is tolerated: the account may already be stopped (that is
    // the dormant state we are recovering from). Only the start must succeed, so
    // stop and start get separate try/catch blocks — a stop that rejects
    // (timeout/disconnect) or returns ok:false must NOT abort the start, which
    // is the operation that actually revives polling.
    let failure: string | null = null;
    try {
      await deps.request("channels.stop", { channel, accountId });
    } catch {
      // Swallow — proceed to start regardless of how the stop failed.
    }
    try {
      const started = await deps.request("channels.start", { channel, accountId });
      if (!started.ok) {
        failure = started.error?.message ?? "channels.start failed";
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    let name: string | null = null;
    try {
      name = await deps.resolveAccountName(channel, accountId);
    } catch {
      name = null;
    }

    await deps.writeAudit({
      actorType: "system",
      actorId: "channel-watchdog",
      eventType: "channel.restarted",
      resource: `agent:${accountId}`,
      outcome: failure === null ? "success" : "failure",
      detail: {
        channel,
        account: { id: accountId, name },
        reason: "polling_conflict",
        lastError: lastError ? safeProviderError(lastError) : null,
        restartAttempt: attempt,
        ...(failure === null ? {} : { error: safeProviderError(failure) }),
      },
    });
  };
}
