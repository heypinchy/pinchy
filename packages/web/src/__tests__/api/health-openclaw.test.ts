import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRestartState = { isRestarting: false, triggeredAt: null as number | null };
const mockConnectionState = { connected: false };

vi.mock("@/server/restart-state", () => ({
  restartState: mockRestartState,
}));

vi.mock("@/server/openclaw-connection-state", () => ({
  openClawConnectionState: mockConnectionState,
}));

describe("GET /api/health/openclaw", () => {
  let GET: typeof import("@/app/api/health/openclaw/route").GET;

  beforeEach(async () => {
    vi.resetModules();
    mockRestartState.isRestarting = false;
    mockRestartState.triggeredAt = null;
    mockConnectionState.connected = false;
    const mod = await import("@/app/api/health/openclaw/route");
    GET = mod.GET;
  });

  it("returns ok with connected: false when not restarting and not connected", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", connected: false });
  });

  it("returns ok with connected: true when OpenClaw is connected", async () => {
    mockConnectionState.connected = true;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", connected: true });
  });

  it("returns restarting with connected: false when restarting", async () => {
    mockRestartState.isRestarting = true;
    mockRestartState.triggeredAt = 1700000000000;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "restarting", connected: false, since: 1700000000000 });
  });
});
