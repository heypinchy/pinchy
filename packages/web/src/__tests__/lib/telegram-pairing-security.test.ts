import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { appendAuditLog } from "@/lib/audit";
import {
  tryAcquireTelegramPairingSlot,
  resetTelegramPairingRateLimiterForTest,
  recordTelegramPairingFailure,
  resetTelegramPairingAuditWindowsForTest,
  isChannelUserIdConflictError,
} from "@/lib/telegram-pairing-security";

describe("tryAcquireTelegramPairingSlot", () => {
  beforeEach(() => {
    resetTelegramPairingRateLimiterForTest();
  });

  it("allows up to 5 attempts per user within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(tryAcquireTelegramPairingSlot("user-1", now)).toBe(true);
    }
  });

  it("denies the 6th attempt in the same window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) tryAcquireTelegramPairingSlot("user-1", now);

    expect(tryAcquireTelegramPairingSlot("user-1", now)).toBe(false);
  });

  it("tracks separate budgets per user — one attacker cannot exhaust another user's budget", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) tryAcquireTelegramPairingSlot("attacker", now);
    expect(tryAcquireTelegramPairingSlot("attacker", now)).toBe(false);

    // A different user's budget is untouched.
    expect(tryAcquireTelegramPairingSlot("victim", now)).toBe(true);
  });

  it("opens a fresh window after 10 minutes", () => {
    const start = 1_000_000;
    for (let i = 0; i < 5; i++) tryAcquireTelegramPairingSlot("user-1", start);
    expect(tryAcquireTelegramPairingSlot("user-1", start)).toBe(false);

    expect(tryAcquireTelegramPairingSlot("user-1", start + 10 * 60_000 + 1)).toBe(true);
  });
});

describe("recordTelegramPairingFailure", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
    resetTelegramPairingAuditWindowsForTest();
  });

  it("writes an auth.telegram_pairing_denied row for the acting user", async () => {
    await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", 1_000_000);

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.eventType).toBe("auth.telegram_pairing_denied");
    expect(call.outcome).toBe("failure");
    expect(call.actorType).toBe("user");
    expect(call.actorId).toBe("user-1");
    expect(call.detail).toMatchObject({ reason: "invalid_or_expired_code" });
  });

  it("throttles to one row per user per minute", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) {
      await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", now + i);
    }

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it("reports the suppressed count on the next window's row", async () => {
    const now = 1_000_000;
    await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", now);
    for (let i = 0; i < 9; i++) {
      await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", now + i);
    }

    await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", now + 60_000);

    expect(appendAuditLog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendAuditLog).mock.calls[1][0].detail).toMatchObject({
      suppressedSinceLastEntry: 9,
    });
  });

  it("keeps separate throttle windows per user", async () => {
    const now = 1_000_000;
    await recordTelegramPairingFailure("user-1", "invalid_or_expired_code", now);
    await recordTelegramPairingFailure("user-2", "invalid_or_expired_code", now);

    expect(appendAuditLog).toHaveBeenCalledTimes(2);
  });

  it("does not throw when appendAuditLog rejects (best-effort logging)", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB down"));

    await expect(
      recordTelegramPairingFailure("user-1", "rate_limited", 1_000_000)
    ).resolves.toBeUndefined();
  });
});

describe("isChannelUserIdConflictError", () => {
  it("recognizes a channel_links_channel_user_id_uniq violation", () => {
    const err = { code: "23505", constraint_name: "channel_links_channel_user_id_uniq" };
    expect(isChannelUserIdConflictError(err)).toBe(true);
  });

  it("rejects a unique violation on a different constraint", () => {
    const err = { code: "23505", constraint_name: "channel_links_user_channel_uniq" };
    expect(isChannelUserIdConflictError(err)).toBe(false);
  });

  it("rejects a non-unique-violation error code", () => {
    const err = { code: "23503", constraint_name: "channel_links_channel_user_id_uniq" };
    expect(isChannelUserIdConflictError(err)).toBe(false);
  });

  it("rejects non-object and null input", () => {
    expect(isChannelUserIdConflictError(null)).toBe(false);
    expect(isChannelUserIdConflictError(undefined)).toBe(false);
    expect(isChannelUserIdConflictError("nope")).toBe(false);
    expect(isChannelUserIdConflictError(new Error("plain error"))).toBe(false);
  });
});
