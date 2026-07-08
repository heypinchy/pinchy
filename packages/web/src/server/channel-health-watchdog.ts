/**
 * ChannelHealthMonitor — the server-side watchdog that makes a silent OpenClaw
 * channel failure (the Telegram getUpdates-409 cross-environment conflict)
 * operator-visible (A-1/A-2/A-4).
 *
 * Pinchy only observes OpenClaw at the gateway-WebSocket level, so a channel
 * worker that crash-loops *below* that boundary is invisible — `connected`
 * stays true and nothing is audited. This monitor closes the gap: it polls
 * `client.channels.status()` on an interval, classifies each account
 * (`channel-health.ts`), and turns transitions into audit rows.
 *
 *   healthy → degraded                one `channel.degraded`   (outcome:failure)
 *   degraded, sustained N checks       one `channel.polling_failed` (failure)
 *   degraded → healthy                 one `channel.recovered`  (outcome:success)
 *
 * State is in-memory per Pinchy process (like the run-watchdog) — a restart
 * re-derives it from the next probe. (So a Pinchy restart while a channel is
 * still degraded emits one fresh `channel.degraded` for the new process —
 * acceptable: it's one extra row per restart, not a loop.) All deps are
 * injected so the transition
 * logic is unit-tested against real captured `channels.status()` payloads.
 */
import { classifyChannelStatus, type ChannelAccountHealth } from "./channel-health";
import { safeProviderError } from "@/lib/audit";

/** Default scan cadence — every 30s, matching the run-watchdog. */
export const CHANNEL_HEALTH_INTERVAL_MS = 30_000;

/**
 * Consecutive degraded probes before a `channel.polling_failed` escalation.
 * With the 30s cadence this is ~2 minutes of sustained failure — long enough
 * to ignore a single transient restart, short enough to alert before an
 * operator would notice the burnt CPU.
 */
export const DEFAULT_TERMINAL_AFTER_CONSECUTIVE_DEGRADED = 4;

export type ChannelHealthEventType =
  "channel.degraded" | "channel.polling_failed" | "channel.recovered";

export interface ChannelHealthAuditPayload {
  actorType: "system";
  actorId: "channel-watchdog";
  eventType: ChannelHealthEventType;
  resource: string;
  outcome: "failure" | "success";
  detail: {
    channel: string;
    account: { id: string; name: string | null };
    lastError: string | null;
    reconnectAttempts: number;
    consecutiveDegradedChecks: number;
  };
}

export interface ChannelHealthDeps {
  /** Wraps `client.channels.status()`. May reject when OC is unreachable. */
  getChannelStatus: () => Promise<unknown>;
  /**
   * Human-readable label for an account, snapshotted into the audit `{id,name}`
   * pair. For Telegram the accountId is the Pinchy agent id, so this resolves
   * the agent name. May return null when unknown.
   */
  resolveAccountName: (channel: string, accountId: string) => Promise<string | null>;
  writeAudit: (entry: ChannelHealthAuditPayload) => Promise<void>;
  now: () => number;
  terminalAfterConsecutiveDegraded: number;
  /**
   * Auto-disable (#477 layer 2): persist the disabled marker, remove the
   * account from config, and clear its allow-store + audit the action. Called
   * at most once per degradation episode, only when the trigger conditions in
   * `isAutoDisableConflict` all hold. A rejection is swallowed by the caller
   * so one bad account can't poison the tick.
   */
  autoDisableConflictedAccount: (
    channel: string,
    accountId: string,
    lastError: string
  ) => Promise<void>;
  /**
   * Age of the account's connection in ms (time since it was first
   * connected/created), or null when unknown. Used to distinguish a
   * recently-added newcomer (should back off) from a long-standing incumbent
   * (should not auto-disable itself out of a conflict it didn't cause).
   */
  getConnectionAgeMs: (channel: string, accountId: string) => Promise<number | null>;
  /** Feature flag — when false, auto-disable never fires (degraded/polling_failed audits still do). */
  autoDisableEnabled: boolean;
  /** An account younger than this (ms) at the time of the conflict is eligible for auto-disable. */
  recentlyAddedWindowMs: number;
}

/**
 * Telegram's getUpdates 409 conflict text — the ONLY polling_failed reason
 * that triggers auto-disable. Matched case-insensitively on a substring so
 * minor upstream wording changes (capitalization, surrounding context) don't
 * silently break the match. Other polling_failed causes (network errors,
 * invalid token, etc.) must NOT auto-disable — they aren't multi-instance
 * conflicts and disabling on them would just make an outage worse.
 */
const CONFLICT_SIGNAL = "terminated by other getupdates";

function isConflictSignal(lastError: string | null): boolean {
  return lastError !== null && lastError.toLowerCase().includes(CONFLICT_SIGNAL);
}

/** Default recently-added window: 24h. */
export const DEFAULT_RECENTLY_ADDED_WINDOW_MS = 86_400_000;

/**
 * Parse `TELEGRAM_CONFLICT_RECENT_WINDOW_MS`. A missing, empty, non-numeric, or
 * negative value falls back to the 24h default, but an explicit `0` is honored
 * (an operator turning the recently-added gate off) — unlike `Number(x) ||
 * DEFAULT`, which would silently revert 0 back to the default.
 */
export function parseRecentlyAddedWindowMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RECENTLY_ADDED_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RECENTLY_ADDED_WINDOW_MS;
  return n;
}

export interface ChannelHealthSnapshotEntry extends ChannelAccountHealth {
  /** When this account first went degraded in the current episode, else null. */
  degradedSince: number | null;
}

interface Tracker {
  state: "healthy" | "degraded";
  degradedSince: number | null;
  consecutiveDegraded: number;
  auditedDegraded: boolean;
  auditedFailed: boolean;
  last: ChannelAccountHealth;
}

export class ChannelHealthMonitor {
  private trackers = new Map<string, Tracker>();

  private key(h: { channel: string; accountId: string }): string {
    return `${h.channel}:${h.accountId}`;
  }

  /** One probe cycle. Resilient: never throws — a failing probe or audit write
   * is swallowed so the interval loop keeps running. */
  async tick(deps: ChannelHealthDeps): Promise<void> {
    let status: unknown;
    try {
      status = await deps.getChannelStatus();
    } catch {
      // OC unreachable / channels.status unavailable — nothing actionable.
      return;
    }

    const healths = classifyChannelStatus(status);
    const seen = new Set<string>();

    for (const h of healths) {
      const key = this.key(h);
      seen.add(key);
      let t = this.trackers.get(key);
      if (!t) {
        t = {
          state: "healthy",
          degradedSince: null,
          consecutiveDegraded: 0,
          auditedDegraded: false,
          auditedFailed: false,
          last: h,
        };
        this.trackers.set(key, t);
      }
      t.last = h;

      if (h.state === "degraded") {
        if (t.state !== "degraded") {
          t.state = "degraded";
          t.degradedSince = deps.now();
          t.consecutiveDegraded = 0;
        }
        t.consecutiveDegraded += 1;

        if (!t.auditedDegraded) {
          t.auditedDegraded = true;
          await this.audit(deps, "channel.degraded", "failure", h, t.consecutiveDegraded);
        }
        if (t.consecutiveDegraded >= deps.terminalAfterConsecutiveDegraded && !t.auditedFailed) {
          t.auditedFailed = true;
          await this.audit(deps, "channel.polling_failed", "failure", h, t.consecutiveDegraded);
          await this.maybeAutoDisable(deps, h);
        }
      } else {
        if (t.state === "degraded") {
          await this.audit(deps, "channel.recovered", "success", h, t.consecutiveDegraded);
        }
        t.state = "healthy";
        t.degradedSince = null;
        t.consecutiveDegraded = 0;
        t.auditedDegraded = false;
        t.auditedFailed = false;
      }
    }

    // Accounts that vanished from the status (channel removed / bot
    // disconnected) — drop their tracker so a future reconnect starts clean.
    for (const key of [...this.trackers.keys()]) {
      if (!seen.has(key)) this.trackers.delete(key);
    }
  }

  /**
   * Fire auto-disable at most once per degradation episode (guarded by the
   * caller's `!t.auditedFailed` check — this runs exactly at the healthy→
   * polling_failed edge). All conditions must hold:
   *   1. autoDisableEnabled
   *   2. lastError matches the Telegram getUpdates-409 conflict signal
   *   3. the account is recently-added (age < recentlyAddedWindowMs)
   * A long-standing connection or an unknown age is left alone — it stays
   * degraded/polling_failed with the existing audit only, so the newcomer
   * backs off and the incumbent survives.
   */
  private async maybeAutoDisable(deps: ChannelHealthDeps, h: ChannelAccountHealth): Promise<void> {
    if (!deps.autoDisableEnabled) return;
    if (!isConflictSignal(h.lastError)) return;

    let ageMs: number | null;
    try {
      ageMs = await deps.getConnectionAgeMs(h.channel, h.accountId);
    } catch {
      ageMs = null;
    }
    if (ageMs === null || ageMs >= deps.recentlyAddedWindowMs) return;

    try {
      await deps.autoDisableConflictedAccount(h.channel, h.accountId, h.lastError ?? "");
    } catch (err) {
      console.error("[channel-health] autoDisableConflictedAccount failed:", err);
    }
  }

  private async audit(
    deps: ChannelHealthDeps,
    eventType: ChannelHealthEventType,
    outcome: "failure" | "success",
    h: ChannelAccountHealth,
    consecutiveDegradedChecks: number
  ): Promise<void> {
    let name: string | null = null;
    try {
      name = await deps.resolveAccountName(h.channel, h.accountId);
    } catch {
      name = null;
    }
    const entry: ChannelHealthAuditPayload = {
      actorType: "system",
      actorId: "channel-watchdog",
      eventType,
      resource: `agent:${h.accountId}`,
      outcome,
      detail: {
        channel: h.channel,
        account: { id: h.accountId, name },
        // Scrub email PII + cap at 1024 bytes before this lands in an
        // append-only HMAC-signed row. The classifier is channel-agnostic, so a
        // future email/Slack channel's lastError could carry an address — and
        // GDPR erasure on a signed audit row is impossible by design. The live
        // snapshot/UI keeps the full text (ephemeral, admin-only).
        lastError: h.lastError ? safeProviderError(h.lastError) : null,
        reconnectAttempts: h.reconnectAttempts,
        consecutiveDegradedChecks,
      },
    };
    try {
      await deps.writeAudit(entry);
    } catch (err) {
      console.error("[channel-health] writeAudit failed:", err);
    }
  }

  /** Current per-account health for `/api/health/openclaw`. */
  snapshot(): ChannelHealthSnapshotEntry[] {
    return [...this.trackers.values()].map((t) => ({ ...t.last, degradedSince: t.degradedSince }));
  }
}

/**
 * Start the periodic channel-health probe. Returns a stop fn. Mirrors
 * `startRunWatchdog`: unref'd so it never keeps the process alive.
 */
export function startChannelHealthWatchdog(
  monitor: ChannelHealthMonitor,
  deps: ChannelHealthDeps,
  intervalMs: number = CHANNEL_HEALTH_INTERVAL_MS
): () => void {
  const handle = setInterval(() => {
    void monitor.tick(deps).catch((err) => {
      console.error("[channel-health] tick failed:", err);
    });
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
