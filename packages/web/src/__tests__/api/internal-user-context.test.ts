import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({ id: "user-1", role: "user", context: null }),
      },
    },
  },
}));

vi.mock("@/lib/context-sync", () => ({
  syncUserContextToWorkspaces: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";
import { db } from "@/db";
import { PUT } from "@/app/api/internal/users/[userId]/context/route";

function makePutRequest(userId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/internal/users/${userId}/context`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

function makeParams(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

describe("PUT /api/internal/users/:userId/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-1",
      role: "user",
      context: null,
    } as any);
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await PUT(makePutRequest("user-1", { content: "test" }), makeParams("user-1"));
    expect(res.status).toBe(401);
  });

  it("saves user context and triggers sync", async () => {
    const res = await PUT(
      makePutRequest("user-1", { content: "# My Context" }),
      makeParams("user-1")
    );

    expect(res.status).toBe(200);
    expect(syncUserContextToWorkspaces).toHaveBeenCalledWith("user-1");
    expect(restartState.notifyRestart).toHaveBeenCalled();
  });

  it("returns onboardingComplete: true for non-admin users", async () => {
    const res = await PUT(
      makePutRequest("user-1", { content: "# My Context" }),
      makeParams("user-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns onboardingComplete: false for admin when org_context is not set", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      context: null,
    } as any);

    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const res = await PUT(
      makePutRequest("admin-1", { content: "# Admin Context" }),
      makeParams("admin-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(false);
  });

  it("returns onboardingComplete: true for admin when org_context is already set", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      context: null,
    } as any);

    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue("Some org context");

    const res = await PUT(
      makePutRequest("admin-1", { content: "# Admin Context" }),
      makeParams("admin-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns 400 when content is not a string", async () => {
    const res = await PUT(makePutRequest("user-1", { content: 123 }), makeParams("user-1"));
    expect(res.status).toBe(400);
  });
});
