/**
 * Unit tests for the ChannelHealthMonitor — the stateful watchdog that polls
 * OpenClaw `channels.status()`, classifies each account, and turns transitions
 * into audit rows so a silent Telegram getUpdates-409 restart loop becomes
 * operator-visible (A-1/A-2/A-4).
 *
 * Transitions, per account:
 *   healthy → degraded                emit one `channel.degraded`
 *   degraded (sustained N ticks)      emit one `channel.polling_failed`
 *   degraded → healthy                emit one `channel.recovered`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ChannelHealthMonitor,
  type ChannelHealthDeps,
  parseRecentlyAddedWindowMs,
  restartSpacingTicks,
  DEFAULT_RECENTLY_ADDED_WINDOW_MS,
  MAX_RESTART_SPACING_TICKS,
  AUTO_DISABLE_AFTER_RESTART_ATTEMPTS,
} from "@/server/channel-health-watchdog";
import {
  healthyTelegramStatus,
  degradedTelegramStatus,
  CONFLICT_ERROR,
} from "./channel-health.fixtures";

describe("ChannelHealthMonitor", () => {
  let writeAudit: ReturnType<typeof vi.fn>;
  let getChannelStatus: ReturnType<typeof vi.fn>;
  let autoDisableConflictedAccount: ReturnType<typeof vi.fn>;
  let restartConflictedAccount: ReturnType<typeof vi.fn>;
  let getConnectionAgeMs: ReturnType<typeof vi.fn>;
  let monitor: ChannelHealthMonitor;
  let clock: number;
  let deps: ChannelHealthDeps;

  beforeEach(() => {
    writeAudit = vi.fn().mockResolvedValue(undefined);
    getChannelStatus = vi.fn();
    autoDisableConflictedAccount = vi.fn().mockResolvedValue(undefined);
    restartConflictedAccount = vi.fn().mockResolvedValue(undefined);
    // Default: recently-added (1 hour old), well inside the 24h window.
    getConnectionAgeMs = vi.fn().mockResolvedValue(60 * 60 * 1000);
    clock = 1_000_000;
    monitor = new ChannelHealthMonitor();
    deps = {
      getChannelStatus,
      resolveAccountName: vi.fn(async () => "Penny"),
      writeAudit,
      now: () => clock,
      terminalAfterConsecutiveDegraded: 3,
      autoDisableConflictedAccount,
      restartConflictedAccount,
      getConnectionAgeMs,
      autoDisableEnabled: true,
      restartEnabled: true,
      recentlyAddedWindowMs: 86_400_000,
    };
  });

  function auditsOfType(type: string) {
    return writeAudit.mock.calls.map((c) => c[0]).filter((e) => e.eventType === type);
  }

  it("emits nothing while the channel stays healthy", async () => {
    getChannelStatus.mockResolvedValue(healthyTelegramStatus());
    await monitor.tick(deps);
    await monitor.tick(deps);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("emits exactly one channel.degraded on the healthy→degraded edge, with name + conflict error + no PII", async () => {
    getChannelStatus.mockResolvedValueOnce(healthyTelegramStatus());
    await monitor.tick(deps);

    getChannelStatus.mockResolvedValue(degradedTelegramStatus(1));
    await monitor.tick(deps);
    await monitor.tick(deps); // still degraded — must NOT re-emit

    const degraded = auditsOfType("channel.degraded");
    expect(degraded).toHaveLength(1);
    const e = degraded[0];
    expect(e.actorType).toBe("system");
    expect(e.outcome).toBe("failure");
    expect(e.resource).toBe("agent:29ea51b1-67af-4fad-8864-f550c7543333");
    expect(e.detail.channel).toBe("telegram");
    expect(e.detail.account).toEqual({ id: "29ea51b1-67af-4fad-8864-f550c7543333", name: "Penny" });
    expect(e.detail.lastError).toContain("terminated by other getUpdates request");
    expect(JSON.stringify(e.detail)).not.toContain("@"); // no email/PII
  });

  it("scrubs email PII and truncates lastError in the audit detail", async () => {
    // The classifier is channel-agnostic; a future email/Slack channel could
    // put an address in lastError, which must NOT land raw in the HMAC-signed
    // audit row. (Telegram's 409 text has no PII — this guards the general case.)
    const status = degradedTelegramStatus(1) as Record<string, unknown>;
    (
      status.channelAccounts as Record<string, Array<Record<string, unknown>>>
    ).telegram[0].lastError = "auth failed for admin@example.com: " + "x".repeat(2000);
    getChannelStatus.mockResolvedValue(status);

    await monitor.tick(deps);

    const e = auditsOfType("channel.degraded")[0];
    expect(e.detail.lastError).not.toContain("admin@example.com");
    expect(e.detail.lastError).toContain("<email-redacted>");
    expect((e.detail.lastError as string).length).toBeLessThanOrEqual(1024);
  });

  it("escalates to channel.polling_failed after N consecutive degraded ticks, once", async () => {
    getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
    // terminalAfterConsecutiveDegraded = 3
    await monitor.tick(deps); // 1 (also emits degraded)
    await monitor.tick(deps); // 2
    expect(auditsOfType("channel.polling_failed")).toHaveLength(0);
    await monitor.tick(deps); // 3 -> terminal
    await monitor.tick(deps); // 4 -> must NOT re-emit
    const failed = auditsOfType("channel.polling_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].detail.consecutiveDegradedChecks).toBe(3);
    // degraded was emitted exactly once on the first tick
    expect(auditsOfType("channel.degraded")).toHaveLength(1);
  });

  it("emits channel.recovered on degraded→healthy and re-arms for the next episode", async () => {
    getChannelStatus.mockResolvedValue(degradedTelegramStatus(1));
    await monitor.tick(deps); // degraded #1

    getChannelStatus.mockResolvedValue(healthyTelegramStatus());
    await monitor.tick(deps); // recovered
    await monitor.tick(deps); // healthy — no re-emit

    const recovered = auditsOfType("channel.recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].outcome).toBe("success");
    expect(recovered[0].resource).toBe("agent:29ea51b1-67af-4fad-8864-f550c7543333");

    // New degradation episode emits a fresh channel.degraded.
    getChannelStatus.mockResolvedValue(degradedTelegramStatus(1));
    await monitor.tick(deps);
    expect(auditsOfType("channel.degraded")).toHaveLength(2);
  });

  it("snapshot() exposes the current per-account health for the health endpoint", async () => {
    getChannelStatus.mockResolvedValue(degradedTelegramStatus(4));
    await monitor.tick(deps);
    const snap = monitor.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      channel: "telegram",
      accountId: "29ea51b1-67af-4fad-8864-f550c7543333",
      state: "degraded",
      lastError: CONFLICT_ERROR,
    });
    expect(typeof snap[0].degradedSince).toBe("number");
  });

  it("is resilient: a throwing getChannelStatus does not throw and emits nothing", async () => {
    getChannelStatus.mockRejectedValue(new Error("not connected"));
    await expect(monitor.tick(deps)).resolves.toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("is resilient: a throwing writeAudit does not poison the tick", async () => {
    writeAudit.mockRejectedValue(new Error("audit db down"));
    getChannelStatus.mockResolvedValue(degradedTelegramStatus(1));
    await expect(monitor.tick(deps)).resolves.toBeUndefined();
  });

  it("tracks multiple accounts independently", async () => {
    const status = healthyTelegramStatus() as Record<string, unknown>;
    (status.channelAccounts as Record<string, unknown[]>).telegram.push({
      accountId: "acct-2",
      enabled: true,
      configured: true,
      running: false,
      connected: false,
      lastError: "Conflict: terminated by other getUpdates request",
      restartPending: true,
      reconnectAttempts: 1,
    });
    getChannelStatus.mockResolvedValue(status);
    await monitor.tick(deps);
    const degraded = auditsOfType("channel.degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0].detail.account.id).toBe("acct-2");
  });

  // Auto-disable (#477 layer 2): a RECENTLY-ADDED account whose lastError is
  // the Telegram getUpdates-409 conflict signal gets auto-disabled — the
  // newcomer backs off so the incumbent survives. Long-standing connections,
  // non-conflict failures, and a disabled feature flag must never trigger it.
  //
  // With conflict-restarts DISABLED (legacy / operator opt-out), auto-disable
  // fires directly at the polling_failed edge — the pre-layer-3 behavior these
  // tests pin. The restart-enabled arbitration (auto-disable only after the
  // conflict survives restarts) is covered in the layer-3 describe below.
  describe("auto-disable on sustained polling conflict (restarts disabled)", () => {
    beforeEach(() => {
      deps.restartEnabled = false;
    });

    it("calls autoDisableConflictedAccount exactly once when polling_failed fires for a recently-added conflicted account", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps); // 1 (degraded)
      await monitor.tick(deps); // 2
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      await monitor.tick(deps); // 3 -> terminal, fires auto-disable
      await monitor.tick(deps); // 4 -> must NOT re-fire
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);
      expect(autoDisableConflictedAccount).toHaveBeenCalledWith(
        "telegram",
        "29ea51b1-67af-4fad-8864-f550c7543333",
        expect.stringContaining("terminated by other getUpdates request")
      );
    });

    it("does NOT auto-disable a long-standing connection (age >= window) but still audits channel.polling_failed", async () => {
      getConnectionAgeMs.mockResolvedValue(86_400_000); // exactly at the window boundary
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("does NOT auto-disable when connection age is unknown (null)", async () => {
      getConnectionAgeMs.mockResolvedValue(null);
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("does NOT auto-disable when lastError doesn't match the conflict signal", async () => {
      const status = degradedTelegramStatus(2) as Record<string, unknown>;
      (
        status.channelAccounts as Record<string, Array<Record<string, unknown>>>
      ).telegram[0].lastError = "ETIMEDOUT: connection reset";
      (status.channels as Record<string, Record<string, unknown>>).telegram.lastError =
        "ETIMEDOUT: connection reset";
      getChannelStatus.mockResolvedValue(status);
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("matches the conflict signal case-insensitively", async () => {
      const status = degradedTelegramStatus(2) as Record<string, unknown>;
      const upper = "CONFLICT: TERMINATED BY OTHER GETUPDATES REQUEST";
      (
        status.channelAccounts as Record<string, Array<Record<string, unknown>>>
      ).telegram[0].lastError = upper;
      getChannelStatus.mockResolvedValue(status);
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);
    });

    it("never calls autoDisableConflictedAccount when autoDisableEnabled is false", async () => {
      deps.autoDisableEnabled = false;
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("swallows a rejecting autoDisableConflictedAccount without poisoning the tick", async () => {
      autoDisableConflictedAccount.mockRejectedValue(new Error("db down"));
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await expect(monitor.tick(deps)).resolves.toBeUndefined(); // terminal tick
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);
      // The polling_failed audit still landed despite the auto-disable rejection.
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("does not re-fire auto-disable on a fresh degradation episode after recovery", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal -> fires once
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);

      getChannelStatus.mockResolvedValue(healthyTelegramStatus());
      await monitor.tick(deps); // recovered

      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await monitor.tick(deps);
      await monitor.tick(deps);
      await monitor.tick(deps); // terminal again in the new episode
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(2);
    });
  });

  // Conflict-restart recovery (#477 layer 3): once a conflicted account crosses
  // into polling_failed, the watchdog restarts the channel account itself
  // (channels.stop/start) instead of waiting on OpenClaw's internal ingress
  // backoff, which since the isolated-ingress rework compounds to 10 minutes
  // and leaves lastError stale while it sleeps. Restarts are paced on the tick
  // counter with exponential spacing; auto-disable (layer 2) is deferred until
  // the conflict has survived AUTO_DISABLE_AFTER_RESTART_ATTEMPTS restarts, so
  // a stale status snapshot can never disable a bot whose conflict is already
  // gone. terminalAfterConsecutiveDegraded = 3 in these tests, so the decision
  // points sit at consecutiveDegraded 3, 3+6=9, 9+12=21, 21+20=41, …
  describe("conflict-restart recovery (restarts enabled)", () => {
    const ACCOUNT = "29ea51b1-67af-4fad-8864-f550c7543333";

    async function tickTimes(n: number) {
      for (let i = 0; i < n; i++) await monitor.tick(deps);
    }

    it("fires restartConflictedAccount once at the polling_failed edge with channel, account, error, and attempt", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(2);
      expect(restartConflictedAccount).not.toHaveBeenCalled();
      await monitor.tick(deps); // 3 -> polling_failed edge
      expect(restartConflictedAccount).toHaveBeenCalledTimes(1);
      expect(restartConflictedAccount).toHaveBeenCalledWith(
        "telegram",
        ACCOUNT,
        expect.stringContaining("terminated by other getUpdates request"),
        1
      );
    });

    it("does NOT auto-disable at the polling_failed edge while restarts are enabled", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(3); // edge
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
    });

    it("paces follow-up restarts exponentially on the tick counter while the conflict persists", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(8); // consecutive 1..8 — edge at 3 (attempt 1), next decision at 9
      expect(restartConflictedAccount).toHaveBeenCalledTimes(1);
      await monitor.tick(deps); // consecutive 9 -> attempt 2
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
      expect(restartConflictedAccount).toHaveBeenLastCalledWith(
        "telegram",
        ACCOUNT,
        expect.any(String),
        2
      );
      await tickTimes(11); // consecutive 10..20 — next decision at 21
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
    });

    it("defers auto-disable of a recently-added account until the conflict survives the restart threshold, then stops restarting", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(20); // decisions at 3 and 9 -> two restarts, no disable yet
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      await monitor.tick(deps); // consecutive 21: attempts >= 2 -> auto-disable
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2); // no restart after disable
      await tickTimes(30);
      expect(autoDisableConflictedAccount).toHaveBeenCalledTimes(1);
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
    });

    it("keeps restarting a long-standing (incumbent) account at the capped cadence and never auto-disables it", async () => {
      getConnectionAgeMs.mockResolvedValue(86_400_000); // at/over the window
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(41); // decisions at 3, 9, 21, 41
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(restartConflictedAccount).toHaveBeenCalledTimes(4);
      expect(restartConflictedAccount).toHaveBeenLastCalledWith(
        "telegram",
        ACCOUNT,
        expect.any(String),
        4
      );
    });

    it("does NOT restart on a non-conflict degradation (network error), at the edge or later", async () => {
      const status = degradedTelegramStatus(2) as Record<string, unknown>;
      (
        status.channelAccounts as Record<string, Array<Record<string, unknown>>>
      ).telegram[0].lastError = "ETIMEDOUT: connection reset";
      getChannelStatus.mockResolvedValue(status);
      await tickTimes(25);
      expect(restartConflictedAccount).not.toHaveBeenCalled();
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("swallows a rejecting restartConflictedAccount and still advances the pacing", async () => {
      restartConflictedAccount.mockRejectedValue(new Error("gateway timeout"));
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await expect(tickTimes(3)).resolves.toBeUndefined(); // edge attempt
      expect(restartConflictedAccount).toHaveBeenCalledTimes(1);
      await tickTimes(6); // next decision at 9
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);
    });

    it("falls back to restarting when auto-disable is not applicable at the deferred decision point", async () => {
      // Recently-added but the feature flag is off: at consecutive 21 the
      // deferred auto-disable check declines, so the watchdog keeps the
      // account alive with another restart instead of stalling.
      deps.autoDisableEnabled = false;
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(21);
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
      expect(restartConflictedAccount).toHaveBeenCalledTimes(3);
    });

    it("fires the first restart on the tick a LATE conflict signal appears (episode began as a non-conflict blip)", async () => {
      // Real-world shape (seen in E2E tg8): a config-apply channel restart
      // opens the degraded episode with lastError:null; the 409 only lands in
      // channels.status AFTER the polling_failed edge already fired. The
      // conflict machinery must arm itself then — not stay dead for the
      // whole episode.
      const blip = degradedTelegramStatus(2) as Record<string, unknown>;
      (
        blip.channelAccounts as Record<string, Array<Record<string, unknown>>>
      ).telegram[0].lastError = null;
      getChannelStatus.mockResolvedValue(blip);
      await tickTimes(5); // edge at 3 with NO conflict signal — nothing scheduled
      expect(restartConflictedAccount).not.toHaveBeenCalled();
      expect(auditsOfType("channel.polling_failed")).toHaveLength(1);

      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2)); // 409 text appears
      await monitor.tick(deps); // consecutive 6 — late conflict detected
      expect(restartConflictedAccount).toHaveBeenCalledTimes(1);
      expect(restartConflictedAccount).toHaveBeenCalledWith(
        "telegram",
        ACCOUNT,
        expect.stringContaining("terminated by other getUpdates request"),
        1
      );
      // Pacing continues normally: next decision at 6 + spacing(3,1)=12.
      await tickTimes(5); // consecutive 7..11
      expect(restartConflictedAccount).toHaveBeenCalledTimes(1);
      await monitor.tick(deps); // consecutive 12
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
    });

    it("late conflict signal does NOT trigger anything in legacy mode (restarts disabled)", async () => {
      deps.restartEnabled = false;
      const blip = degradedTelegramStatus(2) as Record<string, unknown>;
      (
        blip.channelAccounts as Record<string, Array<Record<string, unknown>>>
      ).telegram[0].lastError = null;
      getChannelStatus.mockResolvedValue(blip);
      await tickTimes(4); // edge at 3 without signal — legacy auto-disable declines
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(5);
      expect(restartConflictedAccount).not.toHaveBeenCalled();
      expect(autoDisableConflictedAccount).not.toHaveBeenCalled();
    });

    it("resets restart pacing on recovery so a new episode starts at attempt 1", async () => {
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(3); // attempt 1
      getChannelStatus.mockResolvedValue(healthyTelegramStatus());
      await monitor.tick(deps); // recovered
      getChannelStatus.mockResolvedValue(degradedTelegramStatus(2));
      await tickTimes(3); // new episode edge
      expect(restartConflictedAccount).toHaveBeenCalledTimes(2);
      expect(restartConflictedAccount).toHaveBeenLastCalledWith(
        "telegram",
        ACCOUNT,
        expect.any(String),
        1
      );
    });
  });
});

// #477 layer 3: exponential restart spacing, capped so a persistent conflict
// settles into a bounded audit/restart cadence instead of unbounded doubling.
describe("restartSpacingTicks", () => {
  it("doubles from the terminal threshold per attempt", () => {
    expect(restartSpacingTicks(3, 1)).toBe(6);
    expect(restartSpacingTicks(3, 2)).toBe(12);
    expect(restartSpacingTicks(4, 1)).toBe(8);
  });

  it("caps at MAX_RESTART_SPACING_TICKS", () => {
    expect(restartSpacingTicks(3, 3)).toBe(MAX_RESTART_SPACING_TICKS);
    expect(restartSpacingTicks(4, 10)).toBe(MAX_RESTART_SPACING_TICKS);
  });

  it("auto-disable deferral threshold is two survived restarts", () => {
    // Pinned: lowering this re-opens the stale-status false-disable window
    // (a cleared conflict must get at least two full restart cycles to prove
    // recovery before a newcomer is backed off permanently).
    expect(AUTO_DISABLE_AFTER_RESTART_ATTEMPTS).toBe(2);
  });
});

// #477 layer 2: the recently-added window env var must be parsed so an explicit
// `0` (operator turning the recently-added gate off) is honored, instead of the
// `Number(x) || DEFAULT` footgun that silently reverts 0 to the 24h default.
describe("parseRecentlyAddedWindowMs", () => {
  it("returns the default when the env var is unset", () => {
    expect(parseRecentlyAddedWindowMs(undefined)).toBe(DEFAULT_RECENTLY_ADDED_WINDOW_MS);
  });

  it("returns the default for an empty or whitespace value", () => {
    expect(parseRecentlyAddedWindowMs("")).toBe(DEFAULT_RECENTLY_ADDED_WINDOW_MS);
    expect(parseRecentlyAddedWindowMs("   ")).toBe(DEFAULT_RECENTLY_ADDED_WINDOW_MS);
  });

  it("returns the default for a non-numeric value", () => {
    expect(parseRecentlyAddedWindowMs("abc")).toBe(DEFAULT_RECENTLY_ADDED_WINDOW_MS);
  });

  it("returns the default for a negative value", () => {
    expect(parseRecentlyAddedWindowMs("-5")).toBe(DEFAULT_RECENTLY_ADDED_WINDOW_MS);
  });

  it("honors an explicit 0 instead of falling back to the default", () => {
    expect(parseRecentlyAddedWindowMs("0")).toBe(0);
  });

  it("returns a valid positive numeric value", () => {
    expect(parseRecentlyAddedWindowMs("60000")).toBe(60000);
  });
});
