import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }),
}));
vi.mock("@/lib/openai-subscription", () => ({
  setOpenAiSubscription: vi.fn(),
  getOpenAiSubscription: vi.fn(),
  SUBSCRIPTION_KEY: "openai_subscription_oauth",
}));
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  deleteSetting: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@pinchy/openai-subscription-oauth", () => ({
  pollForToken: vi.fn(),
}));
vi.mock("@/lib/openai-model-migration", () => ({
  migrateAgentsToCodex: vi.fn().mockResolvedValue([]),
}));

import { POST } from "@/app/api/providers/openai/subscription/poll/route";
import { createPendingFlow, clearPendingFlows } from "@/lib/openai-oauth-state";
import * as oauth from "@pinchy/openai-subscription-oauth";
import * as sub from "@/lib/openai-subscription";
import * as audit from "@/lib/audit";
import * as settings from "@/lib/settings";
import * as migration from "@/lib/openai-model-migration";

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingFlows();
});

function makeRequest(body: object): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/openai/subscription/poll", () => {
  it("returns { status: 'pending' } when token endpoint returns authorization_pending", async () => {
    const flowId = createPendingFlow({
      deviceCode: "dc",
      clientId: "cid",
      interval: 5,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(oauth.pollForToken).mockRejectedValue(
      new Error("device authorization failed: authorization_pending")
    );
    const res = await POST(makeRequest({ flowId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("persists subscription and regenerates config on success", async () => {
    const flowId = createPendingFlow({
      deviceCode: "dc",
      clientId: "cid",
      interval: 0,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(oauth.pollForToken).mockResolvedValue({
      access: "at",
      refresh: "rt",
      expires: Date.now() + 3_600_000,
      accountId: "acc",
      accountEmail: "u@e.com",
    });
    vi.mocked(migration.migrateAgentsToCodex).mockResolvedValue([
      { id: "a1", name: "Agent One", from: "openai/gpt-4o", to: "openai-codex/gpt-4o" },
    ]);
    const res = await POST(makeRequest({ flowId }));
    const body = await res.json();
    expect(body.status).toBe("complete");
    expect(body.accountEmail).toBe("u@e.com");
    expect(body.accountId).toBe("acc");
    expect(body.migratedAgents).toEqual([
      { id: "a1", name: "Agent One", from: "openai/gpt-4o", to: "openai-codex/gpt-4o" },
    ]);
    expect(migration.migrateAgentsToCodex).toHaveBeenCalled();
    expect(sub.setOpenAiSubscription).toHaveBeenCalled();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({ event: "subscription_connected" }),
      })
    );
  });

  it("returns { status: 'failed', reason: 'access_denied' } when user denies", async () => {
    const flowId = createPendingFlow({
      deviceCode: "dc",
      clientId: "cid",
      interval: 0,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(oauth.pollForToken).mockRejectedValue(
      new Error("device authorization failed: access_denied")
    );
    const res = await POST(makeRequest({ flowId }));
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.reason).toBe("access_denied");
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure" })
    );
  });

  it("returns 410 when flow is expired or unknown", async () => {
    const res = await POST(makeRequest({ flowId: "nonexistent" }));
    expect(res.status).toBe(410);
  });

  it("removes existing API key when subscription connects (hard-exclusive)", async () => {
    const flowId = createPendingFlow({
      deviceCode: "dc",
      clientId: "cid",
      interval: 0,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(oauth.pollForToken).mockResolvedValue({
      access: "at",
      refresh: "rt",
      expires: Date.now() + 3_600_000,
      accountId: "acc",
      accountEmail: "u@e.com",
    });
    vi.mocked(settings.getSetting).mockResolvedValue("sk-existing-key");
    const res = await POST(makeRequest({ flowId }));
    expect(res.status).toBe(200);
    expect(settings.deleteSetting).toHaveBeenCalled();
    // Two audit events: api_key_removed + subscription_connected
    expect(audit.appendAuditLog).toHaveBeenCalledTimes(2);
  });
});
