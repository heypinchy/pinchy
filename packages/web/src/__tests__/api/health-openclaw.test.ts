import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";

const mockRestartState = { isRestarting: false, triggeredAt: null as number | null };
const mockConnectionState = { connected: false };
const mockConfigGet = vi.fn();
const mockAgentsList = vi.fn();
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

/** An `agents.list` answer from an OpenClaw whose configured list holds `ids`. */
function runtimeAgents(...ids: string[]) {
  return {
    defaultId: ids[0] ?? "main",
    agents: ids.map((id) => ({ id, name: `Agent ${id}` })),
  };
}

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
    mockGetOpenClawClient.mockReturnValue({
      config: { get: mockConfigGet },
      agents: { list: mockAgentsList },
    });
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
    pushState.trackConfigPushStarted(1);
    pushState.trackConfigPushStarted(2);

    const response = await GET(fakeRequest());
    const body = await response.json();

    expect(body).toEqual({ status: "ok", connected: true, configPushesPending: 2 });

    pushState.trackConfigPushSettled(1);
    pushState.trackConfigPushSettled(2);
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

      // Assert the scrubbed VALUE, not merely the absence of the address: a
      // `not.toContain` is equally satisfied by `null`, by `undefined`, and by
      // the field being dropped altogether — so it would stay green if the
      // mapping regressed to blanking `lastError` and the badge lost its title.
      expect(body.channelHealth[0].lastError).toBe("conflict for user <email-redacted>");
    });
  });

  describe("the unauthenticated modes stay unauthenticated", () => {
    it("does NOT call requireAdmin for the default health check", async () => {
      await GET(fakeRequest());

      expect(mockRequireAdmin).not.toHaveBeenCalled();
    });

    // The `?agentId=` probe is what every E2E stability gate polls, several of
    // them with a bare `fetch` and no cookie (e2e/telegram/media.spec.ts,
    // chats.spec.ts, agent-create-no-restart.spec.ts). If the admin gate ever
    // moved above this branch those suites would fail as an opaque poll
    // timeout, minutes into a Docker run — this pins it one unit test early.
    it("does NOT call requireAdmin for the ?agentId= dispatchability probe", async () => {
      mockAgentsList.mockResolvedValue(runtimeAgents("agent-1"));

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(true);
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
      mockAgentsList.mockResolvedValue(runtimeAgents("agent-1", "agent-2"));

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
      mockAgentsList.mockResolvedValue(runtimeAgents("agent-1"));

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-missing")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    // CI run 41906476538: Pinchy had written Smithers into openclaw.json, but
    // the running OpenClaw never reloaded that file. `config.get` reads the
    // file (see the header of server/agent-readiness.ts), so it named the
    // agent while the dispatch handler — and `agents.list` — still rejected
    // it. A probe that read `config.get` called that state dispatchable.
    it("returns agentDispatchable: false when OC's config names the id but its runtime does not", async () => {
      mockConnectionState.connected = true;
      mockConfigGet.mockResolvedValue({ config: { agents: { list: [{ id: "agent-1" }] } } });
      mockAgentsList.mockResolvedValue(runtimeAgents());

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(body.agentDispatchable).toBe(false);
    });

    // Same predicate as the chat path's readiness gate (dispatchableAgentIds):
    // while OC's configured list is empty, agents.list also reports every agent
    // directory on disk, and the dispatch handler rejects all of them.
    it("returns agentDispatchable: false for an agent OC found only on disk", async () => {
      mockConnectionState.connected = true;
      mockAgentsList.mockResolvedValue({ defaultId: "main", agents: [{ id: "agent-1" }] });

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(body.agentDispatchable).toBe(false);
    });

    it("returns agentDispatchable: false (not 5xx) when agents.list throws — poll-friendly behavior", async () => {
      mockConnectionState.connected = true;
      mockAgentsList.mockRejectedValue(new Error("OpenClaw WS disconnected mid-call"));

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      // Critical: never break the poll loop with a 5xx. The whole point of
      // the probe is to keep retrying until the runtime catches up.
      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    it("returns agentDispatchable: false when the runtime lists no agents (e.g. fresh install)", async () => {
      mockConnectionState.connected = true;
      mockAgentsList.mockResolvedValue({ defaultId: "main", agents: [] });

      const response = await GET(
        fakeRequest("http://localhost/api/health/openclaw?agentId=agent-1")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentDispatchable).toBe(false);
    });

    it("does NOT query OpenClaw when agentId is absent (default health check stays cheap)", async () => {
      mockConnectionState.connected = true;

      await GET(fakeRequest());

      expect(mockAgentsList).not.toHaveBeenCalled();
      expect(mockConfigGet).not.toHaveBeenCalled();
    });
  });
});
