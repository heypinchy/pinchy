import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }),
}));
vi.mock("@/lib/openai-subscription", () => ({
  getOpenAiSubscription: vi.fn(),
  deleteOpenAiSubscription: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { DELETE, GET } from "@/app/api/providers/openai/subscription/route";
import * as sub from "@/lib/openai-subscription";
import * as audit from "@/lib/audit";

const mockSub = {
  accessToken: "a",
  refreshToken: "r",
  accountId: "acc-1",
  accountEmail: "u@e.com",
  expiresAt: new Date().toISOString(),
  connectedAt: "2026-04-20T09:00:00Z",
  refreshFailureCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/providers/openai/subscription", () => {
  it("deletes subscription, regenerates config, and emits audit event", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(mockSub);
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(sub.deleteOpenAiSubscription).toHaveBeenCalled();
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "success",
        detail: expect.objectContaining({
          event: "subscription_disconnected",
          accountEmail: "u@e.com",
        }),
      })
    );
  });

  it("returns 404 when no subscription is active", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(null);
    const res = await DELETE();
    expect(res.status).toBe(404);
  });
});

describe("GET /api/providers/openai/subscription", () => {
  it("returns connected=true with status fields when subscription exists", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(mockSub);
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      connected: true,
      accountEmail: "u@e.com",
      connectedAt: "2026-04-20T09:00:00Z",
      refreshFailureCount: 1,
    });
  });

  it("returns connected=false when no subscription", async () => {
    vi.mocked(sub.getOpenAiSubscription).mockResolvedValue(null);
    const res = await GET();
    expect(await res.json()).toEqual({ connected: false });
  });
});
