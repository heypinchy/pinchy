import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRestartState = { isRestarting: false, triggeredAt: null as number | null };
const mockConnectionState = { connected: false };
const mockConfigGet = vi.fn();
const mockGetOpenClawClient = vi.fn();

vi.mock("@/server/restart-state", () => ({
  restartState: mockRestartState,
}));

vi.mock("@/server/openclaw-connection-state", () => ({
  openClawConnectionState: mockConnectionState,
}));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetOpenClawClient(),
}));

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
