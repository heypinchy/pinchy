import { describe, it, expect, vi, beforeEach } from "vitest";

const { markOpenClawConfigReady, isOpenClawConfigReady } = vi.hoisted(() => ({
  markOpenClawConfigReady: vi.fn(),
  isOpenClawConfigReady: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/openclaw-config-ready", () => ({
  markOpenClawConfigReady,
  isOpenClawConfigReady,
}));

describe("GET /api/internal/openclaw-config-ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOpenClawConfigReady.mockReturnValue(false);
  });

  it("returns 503 before regenerateOpenClawConfig() has completed", async () => {
    isOpenClawConfigReady.mockReturnValue(false);
    const { GET } = await import("@/app/api/internal/openclaw-config-ready/route");
    const response = await GET();
    expect(response.status).toBe(503);
  });

  it("returns 200 after regenerateOpenClawConfig() has completed", async () => {
    isOpenClawConfigReady.mockReturnValue(true);
    const { GET } = await import("@/app/api/internal/openclaw-config-ready/route");
    const response = await GET();
    expect(response.status).toBe(200);
  });
});
