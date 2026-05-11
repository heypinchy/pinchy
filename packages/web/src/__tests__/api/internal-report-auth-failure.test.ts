import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/integrations/auth-state");
vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn(),
}));

import { POST } from "@/app/api/internal/integrations/[connectionId]/report-auth-failure/route";
import { setIntegrationAuthFailed } from "@/lib/integrations/auth-state";
import { validateGatewayToken } from "@/lib/gateway-auth";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/internal/integrations/[id]/report-auth-failure", () => {
  it("returns 401 when gateway token is missing/invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);
    const req = new NextRequest("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "401" }),
    });
    const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(401);
    expect(setIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("calls setIntegrationAuthFailed with actor=system:plugin and provided reason", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(setIntegrationAuthFailed).mockResolvedValue(undefined);
    const req = new NextRequest("http://x", {
      method: "POST",
      headers: { "X-Plugin-Id": "pinchy-odoo", Authorization: "Bearer token" },
      body: JSON.stringify({ reason: "Odoo authenticate returned 401" }),
    });
    const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(204);
    expect(setIntegrationAuthFailed).toHaveBeenCalledWith({
      connectionId: "c1",
      reason: "Odoo authenticate returned 401",
      actor: { type: "system", id: "plugin:pinchy-odoo" },
    });
  });

  it("returns 400 when body is missing required `reason`", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    const req = new NextRequest("http://x", { method: "POST", body: "{}" });
    const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(400);
    expect(setIntegrationAuthFailed).not.toHaveBeenCalled();
  });
});
