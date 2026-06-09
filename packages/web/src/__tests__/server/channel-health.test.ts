/**
 * Unit tests for `classifyChannelStatus` — the pure helper that turns a raw
 * OpenClaw `channels.status()` payload into per-account health verdicts.
 *
 * The fixtures are REAL payloads captured from OpenClaw 2026.6.1 during a
 * telegram getUpdates-409 conflict (see channel-health.fixtures.ts), so the
 * classifier is pinned to ground truth, not a guessed shape.
 */
import { describe, it, expect } from "vitest";
import { classifyChannelStatus } from "@/server/channel-health";
import {
  healthyTelegramStatus,
  degradedTelegramStatus,
  TELEGRAM_ACCOUNT_ID,
  CONFLICT_ERROR,
} from "./channel-health.fixtures";

describe("classifyChannelStatus", () => {
  it("classifies a connected, polling account as healthy", () => {
    const result = classifyChannelStatus(healthyTelegramStatus());
    expect(result).toEqual([
      {
        channel: "telegram",
        accountId: TELEGRAM_ACCOUNT_ID,
        state: "healthy",
        connected: true,
        running: true,
        lastError: null,
        reconnectAttempts: 0,
        restartPending: false,
      },
    ]);
  });

  it("classifies an account in the 409 restart loop as degraded with the conflict error", () => {
    const result = classifyChannelStatus(degradedTelegramStatus(3));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channel: "telegram",
      accountId: TELEGRAM_ACCOUNT_ID,
      state: "degraded",
      connected: false,
      running: false,
      lastError: CONFLICT_ERROR,
      reconnectAttempts: 3,
      restartPending: true,
    });
  });

  it("treats a non-null lastError as degraded even if connected somehow reads true", () => {
    const s = healthyTelegramStatus();
    s.channelAccounts.telegram[0].lastError = "boom";
    expect(classifyChannelStatus(s)[0].state).toBe("degraded");
  });

  it("treats a not-connected configured account as degraded", () => {
    const s = healthyTelegramStatus();
    s.channelAccounts.telegram[0].connected = false;
    expect(classifyChannelStatus(s)[0].state).toBe("degraded");
  });

  it("skips disabled accounts (intentionally off, not a failure)", () => {
    const s = degradedTelegramStatus();
    s.channelAccounts.telegram[0].enabled = false;
    expect(classifyChannelStatus(s)).toEqual([]);
  });

  it("skips unconfigured accounts", () => {
    const s = degradedTelegramStatus();
    s.channelAccounts.telegram[0].configured = false;
    expect(classifyChannelStatus(s)).toEqual([]);
  });

  it("classifies multiple accounts across channels independently", () => {
    const s = healthyTelegramStatus() as Record<string, unknown>;
    // A second, degraded account on the same channel + a healthy slack channel.
    (s.channelAccounts as Record<string, unknown[]>).telegram.push({
      accountId: "acct-2",
      enabled: true,
      configured: true,
      running: false,
      connected: false,
      lastError: "Conflict: terminated by other getUpdates request",
      restartPending: true,
      reconnectAttempts: 5,
    });
    (s.channelAccounts as Record<string, unknown[]>).slack = [
      {
        accountId: "slack-1",
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        lastError: null,
        restartPending: false,
        reconnectAttempts: 0,
      },
    ];
    const byKey = Object.fromEntries(
      classifyChannelStatus(s).map((h) => [`${h.channel}:${h.accountId}`, h.state])
    );
    expect(byKey[`telegram:${TELEGRAM_ACCOUNT_ID}`]).toBe("healthy");
    expect(byKey["telegram:acct-2"]).toBe("degraded");
    expect(byKey["slack:slack-1"]).toBe("healthy");
  });

  it("defaults missing numeric/boolean fields safely (defensive against shape drift)", () => {
    const s = {
      channelAccounts: {
        telegram: [{ accountId: "bare", enabled: true, configured: true, connected: false }],
      },
    };
    const h = classifyChannelStatus(s)[0];
    expect(h).toMatchObject({
      channel: "telegram",
      accountId: "bare",
      state: "degraded",
      reconnectAttempts: 0,
      restartPending: false,
    });
  });

  it("returns [] for an empty / missing / malformed payload", () => {
    expect(classifyChannelStatus(undefined)).toEqual([]);
    expect(classifyChannelStatus(null)).toEqual([]);
    expect(classifyChannelStatus({})).toEqual([]);
    expect(classifyChannelStatus({ channelAccounts: {} })).toEqual([]);
    expect(classifyChannelStatus({ channelAccounts: { telegram: [] } })).toEqual([]);
    expect(classifyChannelStatus("nonsense")).toEqual([]);
  });
});
