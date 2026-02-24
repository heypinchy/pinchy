import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRestartState = { isRestarting: false, triggeredAt: null as number | null };

vi.mock("@/server/restart-state", () => ({
  restartState: mockRestartState,
}));

describe("GET /api/health/openclaw", () => {
  let GET: typeof import("@/app/api/health/openclaw/route").GET;

  beforeEach(async () => {
    vi.resetModules();
    mockRestartState.isRestarting = false;
    mockRestartState.triggeredAt = null;
    const mod = await import("@/app/api/health/openclaw/route");
    GET = mod.GET;
  });

  it("returns ok when not restarting", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns restarting with timestamp when restarting", async () => {
    mockRestartState.isRestarting = true;
    mockRestartState.triggeredAt = 1700000000000;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "restarting", since: 1700000000000 });
  });
});
