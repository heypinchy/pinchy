import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

const mockUpdateTelegramChannelConfig = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  updateTelegramChannelConfig: (...args: unknown[]) => mockUpdateTelegramChannelConfig(...args),
}));

const mockClearAllowStoreForAccount = vi.fn();
vi.mock("@/lib/telegram-allow-store", () => ({
  clearAllowStoreForAccount: (...args: unknown[]) => mockClearAllowStoreForAccount(...args),
}));

const mockAppendAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  safeProviderError: (s: string) => s,
}));

const mockRecordAuditFailure = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

import { autoDisableConflictedTelegramAccount } from "@/server/telegram-auto-disable";

const resolveAccountName = vi.fn(async () => "Sales Bot");
const CONFLICT = "Conflict: terminated by other getUpdates request";

describe("autoDisableConflictedTelegramAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
    mockClearAllowStoreForAccount.mockResolvedValue(undefined);
    mockAppendAuditLog.mockResolvedValue({ id: 1, rowHmac: "h" });
  });

  it("marks the account, takes it out of the config, clears its list and audits it", async () => {
    await autoDisableConflictedTelegramAccount("telegram", "agent-1", CONFLICT, resolveAccountName);

    expect(mockSetSetting).toHaveBeenCalledWith(
      "telegram_conflict_disabled:agent-1",
      expect.stringContaining("polling_conflict")
    );
    expect(mockUpdateTelegramChannelConfig).toHaveBeenCalledWith("agent-1", null);
    expect(mockClearAllowStoreForAccount).toHaveBeenCalledWith("agent-1");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "channel.auto_disabled",
        resource: "agent:agent-1",
        outcome: "success",
        detail: expect.objectContaining({ account: { id: "agent-1", name: "Sales Bot" } }),
      })
    );
  });

  it("does nothing when the account is disabled already", async () => {
    mockGetSetting.mockResolvedValue('{"reason":"polling_conflict"}');

    await autoDisableConflictedTelegramAccount("telegram", "agent-1", CONFLICT, resolveAccountName);

    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(mockUpdateTelegramChannelConfig).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  // The bot keeps polling until the config lands, so its list is what keeps it
  // from answering anyone. A config write that throws must not skip clearing
  // it, nor leave the disable — the marker is already set — out of the audit trail.
  it("clears the list and audits the disable as failed when the config write fails", async () => {
    mockUpdateTelegramChannelConfig.mockImplementationOnce(() => {
      throw new Error("EACCES /root/.openclaw/openclaw.json");
    });

    await expect(
      autoDisableConflictedTelegramAccount("telegram", "agent-1", CONFLICT, resolveAccountName)
    ).rejects.toThrow(/EACCES/);

    expect(mockClearAllowStoreForAccount).toHaveBeenCalledWith("agent-1");
    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      eventType: "channel.auto_disabled",
      outcome: "failure",
      error: { message: expect.any(String) },
    });
    expect(JSON.stringify(entry)).not.toContain("/root/.openclaw");
  });

  it("still audits when clearing the list fails", async () => {
    mockClearAllowStoreForAccount.mockRejectedValueOnce(new Error("gateway timeout"));

    await autoDisableConflictedTelegramAccount("telegram", "agent-1", CONFLICT, resolveAccountName);

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "channel.auto_disabled", outcome: "success" })
    );
  });

  it("hands a failed audit write to recordAuditFailure instead of throwing", async () => {
    const err = new Error("db down");
    mockAppendAuditLog.mockRejectedValueOnce(err);

    await autoDisableConflictedTelegramAccount("telegram", "agent-1", CONFLICT, resolveAccountName);

    expect(mockRecordAuditFailure).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ eventType: "channel.auto_disabled" })
    );
  });
});
