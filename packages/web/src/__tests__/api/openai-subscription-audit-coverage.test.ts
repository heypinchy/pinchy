/**
 * End-to-end audit trail smoke test for the OpenAI subscription flow.
 *
 * Each test case verifies that the correct audit log event is (or is NOT)
 * emitted for every audit-relevant code path across all four route files and
 * the background refresh job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }),
}));

vi.mock("@/lib/openai-subscription", () => ({
  getOpenAiSubscription: vi.fn(),
  setOpenAiSubscription: vi.fn().mockResolvedValue(undefined),
  deleteOpenAiSubscription: vi.fn().mockResolvedValue(undefined),
  SUBSCRIPTION_KEY: "openai_subscription_oauth",
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@pinchy/openai-subscription-oauth", () => ({
  createAuthorizationRequest: vi.fn(),
  pollForToken: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("@/lib/openai-model-migration", () => ({
  migrateAgentsToCodex: vi.fn().mockResolvedValue([]),
  migrateAgentsToApiKey: vi.fn().mockResolvedValue([]),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { POST as startPOST } from "@/app/api/providers/openai/subscription/start/route";
import { POST as pollPOST } from "@/app/api/providers/openai/subscription/poll/route";
import { DELETE as subscriptionDELETE } from "@/app/api/providers/openai/subscription/route";
import { refreshStaleTokens } from "@/lib/openai-subscription-refresh";
import { createPendingFlow, clearPendingFlows } from "@/lib/openai-oauth-state";
import * as oauth from "@pinchy/openai-subscription-oauth";
import * as sub from "@/lib/openai-subscription";
import * as settings from "@/lib/settings";
import * as audit from "@/lib/audit";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: object): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePollFlow() {
  return createPendingFlow({
    deviceCode: "dc",
    clientId: "cid",
    interval: 0,
    expiresAt: Date.now() + 60_000,
  });
}

const MOCK_TOKENS = {
  access: "at",
  refresh: "rt",
  expires: Date.now() + 3_600_000,
  accountId: "acc-1",
  accountEmail: "user@example.com",
};

const MOCK_SUBSCRIPTION: sub.OpenAiSubscription = {
  accessToken: "at-old",
  refreshToken: "rt-old",
  expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired → triggers refresh
  accountId: "acc-1",
  accountEmail: "user@example.com",
  connectedAt: "2026-04-20T00:00:00Z",
  refreshFailureCount: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingFlows();
});

describe("OpenAI subscription audit trail smoke tests", () => {
  // ── 1. start success ────────────────────────────────────────────────────────
  it("start success: does NOT emit an audit event", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      verificationUriComplete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });

    await startPOST(new Request("http://localhost/", { method: "POST" }));

    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  // ── 2. start failure ────────────────────────────────────────────────────────
  it("start failure: emits config.changed / failure / subscription_start_failed", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockRejectedValue(new Error("network error"));

    await startPOST(new Request("http://localhost/", { method: "POST" }));

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "failure",
        detail: expect.objectContaining({ event: "subscription_start_failed" }),
      })
    );
  });

  // ── 3. poll complete WITHOUT existing API key ───────────────────────────────
  it("poll complete (no existing API key): emits exactly one subscription_connected event", async () => {
    vi.mocked(settings.getSetting).mockResolvedValue(null); // no existing key
    vi.mocked(oauth.pollForToken).mockResolvedValue(MOCK_TOKENS);
    const flowId = makePollFlow();

    await pollPOST(makeRequest({ flowId }));

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({ event: "subscription_connected" }),
      })
    );
  });

  // ── 4. poll complete WITH existing API key ──────────────────────────────────
  it("poll complete (existing API key present): emits api_key_removed then subscription_connected", async () => {
    vi.mocked(settings.getSetting).mockResolvedValue("sk-existing-key"); // key exists
    vi.mocked(oauth.pollForToken).mockResolvedValue(MOCK_TOKENS);
    const flowId = makePollFlow();

    await pollPOST(makeRequest({ flowId }));

    expect(audit.appendAuditLog).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(audit.appendAuditLog).mock.calls;
    expect(calls[0][0]).toMatchObject({
      eventType: "config.changed",
      detail: expect.objectContaining({ event: "api_key_removed" }),
    });
    expect(calls[1][0]).toMatchObject({
      eventType: "config.changed",
      detail: expect.objectContaining({ event: "subscription_connected" }),
    });
  });

  // ── 5. poll access_denied ───────────────────────────────────────────────────
  it("poll access_denied: emits config.changed / failure / subscription_connect_failed", async () => {
    vi.mocked(oauth.pollForToken).mockRejectedValue(
      new Error("device authorization failed: access_denied")
    );
    const flowId = makePollFlow();

    await pollPOST(makeRequest({ flowId }));

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "failure",
        detail: expect.objectContaining({ event: "subscription_connect_failed" }),
      })
    );
  });

  // ── 6. disconnect success ───────────────────────────────────────────────────
  it("disconnect success: emits config.changed / success / subscription_disconnected", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(MOCK_SUBSCRIPTION);

    await subscriptionDELETE();

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({ event: "subscription_disconnected" }),
      })
    );
  });

  // ── 7. refresh success ──────────────────────────────────────────────────────
  it("refresh success: emits config.changed / success / token_refreshed", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(MOCK_SUBSCRIPTION);
    vi.mocked(oauth.refreshAccessToken).mockResolvedValue({
      access: "at-new",
      refresh: "rt-new",
      expires: Date.now() + 3_600_000,
    });

    await refreshStaleTokens();

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({ event: "token_refreshed", provider: "openai" }),
      })
    );
  });

  // ── 8. refresh failure ──────────────────────────────────────────────────────
  it("refresh failure: emits config.changed / failure / token_refresh_failed", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(MOCK_SUBSCRIPTION);
    vi.mocked(oauth.refreshAccessToken).mockRejectedValue(
      new Error("token refresh failed: invalid_grant")
    );

    await refreshStaleTokens();

    expect(audit.appendAuditLog).toHaveBeenCalledOnce();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "failure",
        detail: expect.objectContaining({ event: "token_refresh_failed", provider: "openai" }),
      })
    );
  });
});
