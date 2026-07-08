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
import { ChannelHealthMonitor, type ChannelHealthDeps } from "@/server/channel-health-watchdog";
import {
  healthyTelegramStatus,
  degradedTelegramStatus,
  CONFLICT_ERROR,
} from "./channel-health.fixtures";

describe("ChannelHealthMonitor", () => {
  let writeAudit: ReturnType<typeof vi.fn>;
  let getChannelStatus: ReturnType<typeof vi.fn>;
  let autoDisableConflictedAccount: ReturnType<typeof vi.fn>;
  let getConnectionAgeMs: ReturnType<typeof vi.fn>;
  let monitor: ChannelHealthMonitor;
  let clock: number;
  let deps: ChannelHealthDeps;

  beforeEach(() => {
    writeAudit = vi.fn().mockResolvedValue(undefined);
    getChannelStatus = vi.fn();
    autoDisableConflictedAccount = vi.fn().mockResolvedValue(undefined);
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
      getConnectionAgeMs,
      autoDisableEnabled: true,
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
  // the Telegram getUpdates-409 conflict signal gets auto-disabled the moment
  // it crosses into polling_failed — the newcomer backs off so the incumbent
  // survives. Long-standing connections, non-conflict failures, and a disabled
  // feature flag must never trigger it.
  describe("auto-disable on sustained polling conflict", () => {
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
});
