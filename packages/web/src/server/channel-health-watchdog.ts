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
 * On a getUpdates-409 conflict it also ACTS (#477): at the polling_failed edge
 * it restarts the account (layer 3, `channel.restarted`, paced exponentially
 * while the conflict persists), and only once the conflict has survived
 * AUTO_DISABLE_AFTER_RESTART_ATTEMPTS restarts does it auto-disable a
 * recently-added newcomer (layer 2, `channel.auto_disabled`).
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
  /**
   * Conflict-restart recovery (#477 layer 3): bounce the channel account
   * through the gateway's runtime-only `channels.stop`/`channels.start` so a
   * poller left dormant by OpenClaw's post-409 ingress backoff (which
   * compounds to 10 minutes and keeps `lastError` stale while it sleeps)
   * resumes under Pinchy's pacing. Called at the polling_failed edge and then
   * at exponentially spaced tick offsets while the conflict persists. A
   * rejection is swallowed by the caller.
   */
  restartConflictedAccount: (
    channel: string,
    accountId: string,
    lastError: string,
    attempt: number
  ) => Promise<void>;
  /** Feature flag — when false, layer 3 is off and auto-disable fires directly at the polling_failed edge (legacy). */
  restartEnabled: boolean;
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
 * Cap on the tick spacing between conflict-restart attempts, so a persistent
 * conflict settles into a bounded restart/audit cadence (20 ticks = 10 minutes
 * at the 30s production interval) instead of doubling without limit.
 */
export const MAX_RESTART_SPACING_TICKS = 20;

/**
 * How many restarts the conflict must survive before a recently-added account
 * is auto-disabled (layer 2). Two full cycles, not one: right after a restart
 * the status snapshot can still carry the PREVIOUS cycle's 409 while the
 * external conflict is already gone, and disabling on that stale evidence
 * would permanently kill a bot that one more restart would have recovered.
 */
export const AUTO_DISABLE_AFTER_RESTART_ATTEMPTS = 2;

/**
 * Ticks to wait after restart attempt N before the next conflict decision:
 * doubles from the polling_failed threshold, capped. With the defaults
 * (terminalAfter=4, 30s ticks) decisions land ~2, 6, 14, 24, 34… minutes into
 * the episode.
 */
export function restartSpacingTicks(
  terminalAfterConsecutiveDegraded: number,
  attempt: number
): number {
  return Math.min(terminalAfterConsecutiveDegraded * 2 ** attempt, MAX_RESTART_SPACING_TICKS);
}

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
  /** Conflict restarts fired in this degradation episode (#477 layer 3). */
  restartAttempts: number;
  /** consecutiveDegraded threshold for the next restart/auto-disable decision, or null when none is scheduled. */
  nextConflictDecisionAt: number | null;
  /** Set once auto-disable fired for this episode — no further restarts/decisions. */
  conflictActionDone: boolean;
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
          restartAttempts: 0,
          nextConflictDecisionAt: null,
          conflictActionDone: false,
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
          await this.handleConflictDecision(deps, h, t);
        } else if (t.auditedFailed && !t.conflictActionDone) {
          // With a decision scheduled, act when its tick threshold is reached.
          // With NONE scheduled, the episode began without a conflict signal
          // (e.g. a config-apply channel-restart blip) — but the 409 can land
          // in channels.status AFTER the polling_failed edge. Arm the conflict
          // machinery the moment the signal appears instead of leaving the
          // episode dead (legacy mode keeps its single edge-decision only).
          const due =
            t.nextConflictDecisionAt !== null
              ? t.consecutiveDegraded >= t.nextConflictDecisionAt
              : deps.restartEnabled && isConflictSignal(h.lastError);
          if (due) await this.handleConflictDecision(deps, h, t);
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
        t.restartAttempts = 0;
        t.nextConflictDecisionAt = null;
        t.conflictActionDone = false;
      }
    }

    // Accounts that vanished from the status (channel removed / bot
    // disconnected) — drop their tracker so a future reconnect starts clean.
    for (const key of [...this.trackers.keys()]) {
      if (!seen.has(key)) this.trackers.delete(key);
    }
  }

  /**
   * One conflict decision point per pacing threshold: restart the account, or
   * — once the conflict has survived AUTO_DISABLE_AFTER_RESTART_ATTEMPTS
   * restarts — hand a recently-added newcomer to auto-disable. Runs at the
   * polling_failed edge and then at exponentially spaced consecutiveDegraded
   * thresholds; non-conflict degradations (network errors, bad tokens) never
   * schedule anything, and with restarts disabled this degrades to the legacy
   * single auto-disable at the edge.
   */
  private async handleConflictDecision(
    deps: ChannelHealthDeps,
    h: ChannelAccountHealth,
    t: Tracker
  ): Promise<void> {
    if (!isConflictSignal(h.lastError)) return;

    if (!deps.restartEnabled) {
      await this.maybeAutoDisable(deps, h);
      return;
    }

    if (t.restartAttempts >= AUTO_DISABLE_AFTER_RESTART_ATTEMPTS) {
      const disabled = await this.maybeAutoDisable(deps, h);
      if (disabled) {
        t.conflictActionDone = true;
        return;
      }
    }

    t.restartAttempts += 1;
    t.nextConflictDecisionAt =
      t.consecutiveDegraded +
      restartSpacingTicks(deps.terminalAfterConsecutiveDegraded, t.restartAttempts);
    try {
      await deps.restartConflictedAccount(
        h.channel,
        h.accountId,
        h.lastError ?? "",
        t.restartAttempts
      );
    } catch (err) {
      console.error("[channel-health] restartConflictedAccount failed:", err);
    }
  }

  /**
   * Fire auto-disable at most once per degradation episode. All conditions
   * must hold:
   *   1. autoDisableEnabled
   *   2. lastError matches the Telegram getUpdates-409 conflict signal
   *   3. the account is recently-added (age < recentlyAddedWindowMs)
   * A long-standing connection or an unknown age is left alone — it stays
   * degraded/polling_failed with the existing audit only, so the newcomer
   * backs off and the incumbent survives. Returns whether the account was
   * actually handed to auto-disable, so the caller can fall back to another
   * restart instead of stalling the episode.
   */
  private async maybeAutoDisable(
    deps: ChannelHealthDeps,
    h: ChannelAccountHealth
  ): Promise<boolean> {
    if (!deps.autoDisableEnabled) return false;
    if (!isConflictSignal(h.lastError)) return false;

    let ageMs: number | null;
    try {
      ageMs = await deps.getConnectionAgeMs(h.channel, h.accountId);
    } catch {
      ageMs = null;
    }
    if (ageMs === null || ageMs >= deps.recentlyAddedWindowMs) return false;

    try {
      await deps.autoDisableConflictedAccount(h.channel, h.accountId, h.lastError ?? "");
      return true;
    } catch (err) {
      console.error("[channel-health] autoDisableConflictedAccount failed:", err);
      return false;
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
