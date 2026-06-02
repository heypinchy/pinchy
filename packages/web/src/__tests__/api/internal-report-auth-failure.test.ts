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

  it("rejects unknown X-Plugin-Id values rather than recording them as an audit actor", async () => {
    // All Pinchy plugins share the same bootstrap gateway token, so a plugin
    // can claim any X-Plugin-Id in its header. Without validation, a buggy
    // (or malicious) plugin could record auth_failed transitions under
    // another plugin's name in the audit trail. We allowlist against the
    // known Pinchy plugin IDs and reject anything else with 400.
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    const req = new NextRequest("http://x", {
      method: "POST",
      headers: { "X-Plugin-Id": "../../etc/passwd", Authorization: "Bearer token" },
      body: JSON.stringify({ reason: "401" }),
    });
    const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(400);
    expect(setIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("rejects missing X-Plugin-Id header (forces explicit attribution)", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    const req = new NextRequest("http://x", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: JSON.stringify({ reason: "401" }),
    });
    const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(400);
    expect(setIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("accepts every plugin ID in the KNOWN_PINCHY_PLUGINS allowlist", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(setIntegrationAuthFailed).mockResolvedValue(undefined);
    // External-integration plugins are the ones that report auth failures,
    // but we accept any known Pinchy plugin ID — internal ones may grow into
    // this responsibility later (e.g. pinchy-files reporting a workspace
    // mount auth failure).
    for (const pluginId of ["pinchy-odoo", "pinchy-email", "pinchy-web"]) {
      vi.clearAllMocks();
      vi.mocked(validateGatewayToken).mockReturnValue(true);
      vi.mocked(setIntegrationAuthFailed).mockResolvedValue(undefined);
      const req = new NextRequest("http://x", {
        method: "POST",
        headers: { "X-Plugin-Id": pluginId, Authorization: "Bearer token" },
        body: JSON.stringify({ reason: "401" }),
      });
      const res = await POST(req, { params: Promise.resolve({ connectionId: "c1" }) });
      expect(res.status, `expected 204 for ${pluginId}`).toBe(204);
      expect(setIntegrationAuthFailed).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { type: "system", id: `plugin:${pluginId}` } })
      );
    }
  });
});
