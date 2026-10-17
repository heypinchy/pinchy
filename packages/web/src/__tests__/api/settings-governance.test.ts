import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("@/lib/instance-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instance-policy")>();
  return { ...actual, getInstancePolicy: vi.fn(), setInstancePolicy: vi.fn() };
});
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

import { getInstancePolicy, setInstancePolicy } from "@/lib/instance-policy";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { GET, PUT } from "@/app/api/settings/governance/route";

const ON = { memberPersonalAgents: true, memberAutomations: true };

function signedInAs(role: "admin" | "member" | null) {
  getSessionMock.mockResolvedValue(role ? { user: { id: `${role}-1`, role } } : null);
}

function put(body: unknown) {
  return PUT(
    makeNextRequest("http://localhost/api/settings/governance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext()
  );
}

describe("GET /api/settings/governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstancePolicy).mockResolvedValue(ON);
  });

  it("answers any signed-in user, so a member's UI can explain an empty sidebar", async () => {
    signedInAs("member");
    const res = await GET(
      makeNextRequest("http://localhost/api/settings/governance"),
      routeContext()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ON);
  });

  it("answers 401 without a session", async () => {
    signedInAs(null);
    const res = await GET(
      makeNextRequest("http://localhost/api/settings/governance"),
      routeContext()
    );
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/settings/governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstancePolicy).mockResolvedValue(ON);
  });

  it("is admin-only", async () => {
    signedInAs("member");
    const res = await put({ memberPersonalAgents: false, memberAutomations: true });
    expect(res.status).toBe(403);
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it("rejects a body that is not both switches as booleans", async () => {
    signedInAs("admin");
    const res = await put({ memberPersonalAgents: "false" });
    expect(res.status).toBe(400);
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it("stores the switches and audits only what changed, as a from/to diff", async () => {
    signedInAs("admin");
    const res = await put({ memberPersonalAgents: true, memberAutomations: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memberPersonalAgents: true, memberAutomations: false });
    expect(setInstancePolicy).toHaveBeenCalledWith({
      memberPersonalAgents: true,
      memberAutomations: false,
    });
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "settings.updated",
      resource: "settings",
      detail: { changes: { memberAutomations: { from: true, to: false } } },
      outcome: "success",
    });
  });

  it("refreshes OpenClaw and the Telegram allow stores when the personal-agent switch moves", async () => {
    signedInAs("admin");
    await put({ memberPersonalAgents: false, memberAutomations: true });

    // Telegram reaches a member's Smithers without passing Pinchy, so the
    // routing bindings and allow stores are where that door closes.
    expect(regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(recalculateTelegramAllowStores).toHaveBeenCalledTimes(1);
  });

  it("does not touch OpenClaw when only the automations switch moves", async () => {
    signedInAs("admin");
    await put({ memberPersonalAgents: true, memberAutomations: false });

    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(recalculateTelegramAllowStores).not.toHaveBeenCalled();
  });

  it("writes no audit row for a save that changed nothing", async () => {
    signedInAs("admin");
    const res = await put(ON);

    expect(res.status).toBe(200);
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it("re-runs the OpenClaw and Telegram refresh on an unchanged save, so a failed one can be retried", async () => {
    signedInAs("admin");
    // First save: the switch is stored, then the refresh fails.
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("OpenClaw restarting"));
    await expect(put({ memberPersonalAgents: false, memberAutomations: true })).rejects.toThrow();

    // The admin saves again. The stored value already matches, so nothing is
    // audited — but the refresh that never happened must happen now, or
    // members keep reaching Smithers over Telegram while the switch reads off.
    vi.mocked(getInstancePolicy).mockResolvedValue({
      memberPersonalAgents: false,
      memberAutomations: true,
    });
    vi.mocked(regenerateOpenClawConfig).mockClear();
    vi.mocked(recalculateTelegramAllowStores).mockClear();
    const res = await put({ memberPersonalAgents: false, memberAutomations: true });

    expect(res.status).toBe(200);
    expect(regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(recalculateTelegramAllowStores).toHaveBeenCalledTimes(1);
  });
});
