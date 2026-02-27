import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/settings", () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/context-sync", () => ({
  syncOrgContextToWorkspaces: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";
import { PUT } from "@/app/api/internal/settings/context/route";

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/settings/context", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/internal/settings/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await PUT(makePutRequest({ content: "test" }));
    expect(res.status).toBe(401);
  });

  it("saves org context and triggers sync", async () => {
    const res = await PUT(makePutRequest({ content: "# Org Info" }));

    expect(res.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith("org_context", "# Org Info");
    expect(syncOrgContextToWorkspaces).toHaveBeenCalled();
    expect(restartState.notifyRestart).toHaveBeenCalled();
  });

  it("returns onboardingComplete: true", async () => {
    const res = await PUT(makePutRequest({ content: "# Org Info" }));

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns 400 when content is not a string", async () => {
    const res = await PUT(makePutRequest({ content: 42 }));
    expect(res.status).toBe(400);
  });
});
