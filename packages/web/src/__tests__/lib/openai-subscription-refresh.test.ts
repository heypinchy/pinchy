import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/openai-subscription", () => ({
  getOpenAiSubscription: vi.fn(),
  setOpenAiSubscription: vi.fn(),
}));

vi.mock("@pinchy/openai-subscription-oauth", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn(),
}));

import * as subscriptionLib from "@/lib/openai-subscription";
import * as oauthLib from "@pinchy/openai-subscription-oauth";
import * as openclawConfig from "@/lib/openclaw-config";
import * as audit from "@/lib/audit";
import { refreshStaleTokens } from "@/lib/openai-subscription-refresh";

const mockGetOpenAiSubscription = vi.mocked(subscriptionLib.getOpenAiSubscription);
const mockSetOpenAiSubscription = vi.mocked(subscriptionLib.setOpenAiSubscription);
const mockRefreshAccessToken = vi.mocked(oauthLib.refreshAccessToken);
const mockRegenerateOpenClawConfig = vi.mocked(openclawConfig.regenerateOpenClawConfig);
const mockAppendAuditLog = vi.mocked(audit.appendAuditLog);

const BASE_SUBSCRIPTION: subscriptionLib.OpenAiSubscription = {
  accessToken: "at-old",
  refreshToken: "rt-old",
  expiresAt: new Date(0).toISOString(), // will be overridden per test
  accountId: "acc-1",
  accountEmail: "user@example.com",
  connectedAt: "2026-04-20T00:00:00Z",
  refreshFailureCount: 0,
};

describe("refreshStaleTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetOpenAiSubscription.mockResolvedValue(undefined);
    mockRegenerateOpenClawConfig.mockResolvedValue(undefined);
    mockAppendAuditLog.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when no subscription is stored", async () => {
    mockGetOpenAiSubscription.mockResolvedValue(null);

    await refreshStaleTokens();

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    expect(mockSetOpenAiSubscription).not.toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("is a no-op when token expires more than 30 minutes from now", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T12:00:00Z");
    vi.setSystemTime(now);

    const expiresAt = new Date(now.getTime() + 31 * 60 * 1000).toISOString(); // 31 min away
    mockGetOpenAiSubscription.mockResolvedValue({ ...BASE_SUBSCRIPTION, expiresAt });

    await refreshStaleTokens();

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    expect(mockSetOpenAiSubscription).not.toHaveBeenCalled();
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("refreshes token and updates subscription when within 30 minutes of expiry", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T12:00:00Z");
    vi.setSystemTime(now);

    const expiresAt = new Date(now.getTime() + 20 * 60 * 1000).toISOString(); // 20 min away
    const subscription = { ...BASE_SUBSCRIPTION, expiresAt };
    mockGetOpenAiSubscription.mockResolvedValue(subscription);

    const newExpires = now.getTime() + 3600 * 1000;
    mockRefreshAccessToken.mockResolvedValue({
      access: "at-new",
      refresh: "rt-new",
      expires: newExpires,
    });

    await refreshStaleTokens();

    expect(mockRefreshAccessToken).toHaveBeenCalledWith({
      refresh: "rt-old",
      clientId: expect.any(String),
    });

    expect(mockSetOpenAiSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "at-new",
        refreshToken: "rt-new",
        expiresAt: new Date(newExpires).toISOString(),
        refreshFailureCount: 0,
        lastRefreshAt: now.toISOString(),
      })
    );

    expect(mockRegenerateOpenClawConfig).toHaveBeenCalledOnce();

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "system",
        actorId: "system",
        eventType: "config.changed",
        resource: "settings:openai_subscription",
        outcome: "success",
        detail: {
          event: "token_refreshed",
          provider: "openai",
          accountEmail: "user@example.com",
        },
      })
    );
  });

  it("increments refreshFailureCount and logs failure when refreshAccessToken throws", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T12:00:00Z");
    vi.setSystemTime(now);

    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5 min away
    const subscription = { ...BASE_SUBSCRIPTION, expiresAt, refreshFailureCount: 2 };
    mockGetOpenAiSubscription.mockResolvedValue(subscription);

    mockRefreshAccessToken.mockRejectedValue(new Error("token refresh failed: invalid_grant"));

    await refreshStaleTokens();

    expect(mockSetOpenAiSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshFailureCount: 3,
      })
    );

    // must NOT regenerate config on failure
    expect(mockRegenerateOpenClawConfig).not.toHaveBeenCalled();

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "system",
        actorId: "system",
        eventType: "config.changed",
        resource: "settings:openai_subscription",
        outcome: "failure",
        error: { message: "token refresh failed: invalid_grant" },
        detail: {
          event: "token_refresh_failed",
          provider: "openai",
          accountEmail: "user@example.com",
          failureCount: 3,
        },
      })
    );
  });

  it("does not re-throw when refreshAccessToken throws", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-20T12:00:00Z");
    vi.setSystemTime(now);

    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    mockGetOpenAiSubscription.mockResolvedValue({ ...BASE_SUBSCRIPTION, expiresAt });
    mockRefreshAccessToken.mockRejectedValue(new Error("network error"));

    await expect(refreshStaleTokens()).resolves.toBeUndefined();
  });
});
