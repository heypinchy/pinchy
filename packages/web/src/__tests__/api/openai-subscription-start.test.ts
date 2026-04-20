import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi
    .fn()
    .mockResolvedValue({ user: { id: "admin-1", email: "admin@test.com", role: "admin" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@pinchy/openai-subscription-oauth", () => ({
  createAuthorizationRequest: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/providers/openai/subscription/start/route";
import * as oauth from "@pinchy/openai-subscription-oauth";
import { appendAuditLog } from "@/lib/audit";
import { clearPendingFlows } from "@/lib/openai-oauth-state";

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingFlows();
});

describe("POST /api/providers/openai/subscription/start", () => {
  it("initiates the device flow and returns user-visible fields", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      verificationUriComplete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    const res = await POST(new Request("http://localhost/", { method: "POST" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.userCode).toBe("ABCD-EFGH");
    expect(body.verificationUriComplete).toContain("user_code=ABCD-EFGH");
    expect(body.interval).toBe(5);
    expect(body.flowId).toMatch(/[0-9a-f-]{36}/);
    // deviceCode must NOT be returned to the client
    expect(body.deviceCode).toBeUndefined();
  });

  it("does not call appendAuditLog on success", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      verificationUriComplete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    await POST(new Request("http://localhost/", { method: "POST" }));
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 500 when createAuthorizationRequest throws", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockRejectedValue(new Error("network error"));
    const res = await POST(new Request("http://localhost/", { method: "POST" }));
    expect(res.status).toBe(500);
  });

  it("calls appendAuditLog with failure outcome when createAuthorizationRequest throws", async () => {
    vi.mocked(oauth.createAuthorizationRequest).mockRejectedValue(new Error("network error"));
    await POST(new Request("http://localhost/", { method: "POST" }));
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        error: { message: "network error" },
      })
    );
  });
});
