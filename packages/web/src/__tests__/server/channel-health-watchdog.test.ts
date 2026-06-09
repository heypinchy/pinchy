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
  let monitor: ChannelHealthMonitor;
  let clock: number;
  let deps: ChannelHealthDeps;

  beforeEach(() => {
    writeAudit = vi.fn().mockResolvedValue(undefined);
    getChannelStatus = vi.fn();
    clock = 1_000_000;
    monitor = new ChannelHealthMonitor();
    deps = {
      getChannelStatus,
      resolveAccountName: vi.fn(async () => "Penny"),
      writeAudit,
      now: () => clock,
      terminalAfterConsecutiveDegraded: 3,
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
});
