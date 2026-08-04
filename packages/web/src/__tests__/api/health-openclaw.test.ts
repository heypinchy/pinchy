import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const mockRestartState = { isRestarting: false, triggeredAt: null as number | null };
const mockConnectionState = { connected: false };
const mockConfigGet = vi.fn();
const mockGetOpenClawClient = vi.fn();
const mockRequireAdmin = vi.fn();
const mockSnapshot = vi.fn();
const mockGetChannelHealthMonitor = vi.fn();

vi.mock("@/server/restart-state", () => ({
  restartState: mockRestartState,
}));

vi.mock("@/server/openclaw-connection-state", () => ({
  openClawConnectionState: mockConnectionState,
}));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetOpenClawClient(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

vi.mock("@/server/channel-health-singleton", () => ({
  getChannelHealthMonitor: () => mockGetChannelHealthMonitor(),
}));

import { mockSession } from "@/test-helpers/auth";

function fakeRequest(url = "http://localhost/api/health/openclaw"): NextRequest {
  // Only `nextUrl.searchParams` is consumed by the route — minimal shim.
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

describe("GET /api/health/openclaw", () => {
  let GET: typeof import("@/app/api/health/openclaw/route").GET;
  let pushState: typeof import("@/lib/openclaw-config/push-state");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockRestartState.isRestarting = false;
    mockRestartState.triggeredAt = null;
    mockConnectionState.connected = false;
    mockGetOpenClawClient.mockReturnValue({ config: { get: mockConfigGet } });
    mockRequireAdmin.mockResolvedValue(mockSession());
    mockSnapshot.mockReturnValue([]);
    mockGetChannelHealthMonitor.mockReturnValue({ snapshot: mockSnapshot });
    // The push-state tracker is globalThis-backed (NOT mocked here): the route
    // must read the same counter `pushConfigInBackground` writes, across the
    // Next-route vs custom-server module-graph split.
    pushState = await import("@/lib/openclaw-config/push-state");
    pushState._resetConfigPushState();
    const mod = await import("@/app/api/health/openclaw/route");
    GET = mod.GET;
  });

  it("returns ok with connected: false when not restarting and not connected", async () => {
    const response = await GET(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", connected: false, configPushesPending: 0 });
  });

  it("returns ok with connected: true when OpenClaw is connected", async () => {
    mockConnectionState.connected = true;

    const response = await GET(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", connected: true, configPushesPending: 0 });
  });

  it("reports configPushesPending while a background config push is in flight", async () => {
    // The email dispatch-probe flake: a rate-limited config.apply can park a
    // push coroutine 33–53 s; health reported connected=true the whole time,
    // so E2E stability gates dispatched into the gap and the agent ran without
    // its freshly-granted tools. The gate needs this counter to wait it out.
    mockConnectionState.connected = true;
    pushState.trackConfigPushStarted();
    pushState.trackConfigPushStarted();

    const response = await GET(fakeRequest());
    const body = await response.json();

    expect(body).toEqual({ status: "ok", connected: true, configPushesPending: 2 });

    pushState.trackConfigPushSettled();
    pushState.trackConfigPushSettled();
    const after = await (await GET(fakeRequest())).json();
    expect(after.configPushesPending).toBe(0);
  });

  describe("with ?channelHealth=1 (admin-only snapshot)", () => {
    it("returns 401 for an unauthenticated caller and does NOT read the snapshot", async () => {
      mockRequireAdmin.mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?channelHealth=1")
      );

      expect(response.status).toBe(401);
      expect(mockSnapshot).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin member and does NOT read the snapshot", async () => {
      mockRequireAdmin.mockResolvedValue(
        NextResponse.json({ error: "Forbidden" }, { status: 403 })
      );

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?channelHealth=1")
      );

      expect(response.status).toBe(403);
      expect(mockSnapshot).not.toHaveBeenCalled();
    });

    it("returns the snapshot for an admin", async () => {
      mockRequireAdmin.mockResolvedValue(mockSession());
      mockSnapshot.mockReturnValue([
        {
          channel: "telegram",
          accountId: "agent-1",
          state: "degraded",
          connected: false,
          running: false,
          lastError: "getUpdates conflict",
          reconnectAttempts: 3,
          restartPending: false,
          degradedSince: 1700000000000,
        },
      ]);

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?channelHealth=1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.channelHealth).toEqual([
        expect.objectContaining({ accountId: "agent-1", lastError: "getUpdates conflict" }),
      ]);
    });

    it("scrubs lastError through safeProviderError before returning it", async () => {
      mockRequireAdmin.mockResolvedValue(mockSession());
      mockSnapshot.mockReturnValue([
        {
          channel: "telegram",
          accountId: "agent-1",
          state: "degraded",
          connected: false,
          running: false,
          lastError: "conflict for user someone@example.com",
          reconnectAttempts: 1,
          restartPending: false,
          degradedSince: 1700000000000,
        },
      ]);

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?channelHealth=1")
      );
      const body = await response.json();

      expect(body.channelHealth[0].lastError).not.toContain("someone@example.com");
    });

    it("does NOT call requireAdmin for the default health check (stays public)", async () => {
      await GET(fakeRequest());

      expect(mockRequireAdmin).not.toHaveBeenCalled();
    });
  });

  it("returns restarting with connected: false when restarting", async () => {
    mockRestartState.isRestarting = true;
    mockRestartState.triggeredAt = 1700000000000;

    const response = await GET(fakeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "restarting", connected: false, since: 1700000000000 });
  });

  describe("with ?agentId= query param (Tier 2b race fix — dispatchability probe)", () => {
    it("returns agentDispatchable: true when OC's runtime agents.list contains the id", async () => {
      mockConnectionState.connected = true;
      mockConfigGet.mockResolvedValue({
        config: { agents: { list: [{ id: "agent-1" }, { id: "agent-2" }] } },
      });

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        status: "ok",
        connected: true,
        configPushesPending: 0,
        agentDispatchable: true,
      });
    });

    it("returns agentDispatchable: false when the requested id is NOT in OC's list", async () => {
      mockConnectionState.connected = true;
      mockConfigGet.mockResolvedValue({
        config: { agents: { list: [{ id: "agent-1" }] } },
      });

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-missing")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    it("returns agentDispatchable: false (not 5xx) when config.get throws — poll-friendly behavior", async () => {
      mockConnectionState.connected = true;
      mockConfigGet.mockRejectedValue(new Error("OpenClaw WS disconnected mid-call"));

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      // Critical: never break the poll loop with a 5xx. The whole point of
      // the probe is to keep retrying until the runtime catches up.
      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    it("returns agentDispatchable: false when config.get returns no agents list (e.g. fresh install)", async () => {
      mockConnectionState.connected = true;
      mockConfigGet.mockResolvedValue({ config: {} });

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    it("does NOT call config.get when agentId is absent (default health check stays cheap)", async () => {
      mockConnectionState.connected = true;

      await GET(fakeRequest());

      expect(mockConfigGet).not.toHaveBeenCalled();
    });
  });
});
