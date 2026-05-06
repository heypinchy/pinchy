import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return {
    ...actual,
    getCachedDomain: vi.fn(),
  };
});

import { getCachedDomain } from "@/lib/domain-cache";
import { isHostAllowed } from "@/server/host-check";

const composePath = resolve(__dirname, "../../../../../docker-compose.yml");
const compose = readFileSync(composePath, "utf-8");

function extractPinchyHealthcheckPath(): string {
  const match = compose.match(/http:\/\/localhost:7777([^'"`)\s]+)/);
  if (!match?.[1]) {
    throw new Error("Could not find the Pinchy localhost healthcheck URL in docker-compose.yml");
  }
  return match[1];
}

describe("deployment healthcheck smoke", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReset();
  });

  it("keeps the Compose healthcheck compatible with Domain Lock", () => {
    // Regression guard for #283: production Compose probes Pinchy via
    // localhost from inside the container. If the healthcheck path is not
    // exempt from Domain Lock, a locked instance returns 403, Pinchy is marked
    // unhealthy, and OpenClaw never starts.
    const healthcheckPath = extractPinchyHealthcheckPath();

    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");

    expect(healthcheckPath).toBe("/api/internal/openclaw-config-ready");
    expect(isHostAllowed("localhost:7777", healthcheckPath)).toBe(true);
  });

  it("keeps OpenClaw gated on the Pinchy healthcheck", () => {
    expect(compose).toMatch(
      /openclaw:[\s\S]*depends_on:[\s\S]*pinchy:[\s\S]*condition: service_healthy/
    );
  });
});
