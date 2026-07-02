import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";
import { NextRequest } from "next/server";
import { openClawConnectionState } from "@/server/openclaw-connection-state";

describe("GET /api/health", () => {
  const originalConnected = openClawConnectionState.connected;

  beforeEach(() => {
    openClawConnectionState.connected = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    openClawConnectionState.connected = originalConnected;
  });

  it("should return 200 with status ok", async () => {
    const request = new NextRequest("http://localhost/api/health", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ status: "ok" });
  });

  it("should return JSON content type", async () => {
    const request = new NextRequest("http://localhost/api/health", { method: "GET" });
    const response = await GET(request);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("application/json");
  });

  // Issue #156: operators need to see WHERE secrets come from (provenance
  // only — never values) to avoid rotating auto-generated secrets that
  // didn't need rotating.
  it("exposes secret provenance without leaking any secret values", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    vi.stubEnv("BETTER_AUTH_SECRET", "super-secret-auth-value");
    vi.stubEnv("DATABASE_URL", "postgresql://pinchy:pinchy_dev@db:5432/pinchy");

    const request = new NextRequest("http://localhost/api/health", { method: "GET" });
    const response = await GET(request);
    const data = await response.json();

    expect(data.secrets).toEqual({
      encryption_key: "envvar",
      auth_secret: "envvar",
      audit_hmac_secret: expect.stringMatching(/^(envvar|file|unset)$/),
      db_password: "default",
    });

    // Provenance only: no secret material may appear anywhere in the body.
    const body = JSON.stringify(data);
    expect(body).not.toContain("a".repeat(64));
    expect(body).not.toContain("super-secret-auth-value");
    expect(body).not.toContain("pinchy_dev");
  });

  // Issue #651: the 2026-07-02 staging incident had the OpenClaw gateway
  // client dead while `/api/health` reported `status: "ok"` the whole time —
  // chat was completely unavailable and no monitor could see it.
  describe("openclaw connectivity (#651)", () => {
    it("reports openclaw.connected: true when the gateway client is connected", async () => {
      openClawConnectionState.connected = true;

      const request = new NextRequest("http://localhost/api/health", { method: "GET" });
      const response = await GET(request);
      const data = await response.json();

      expect(data.openclaw).toEqual({ connected: true });
    });

    it("reports openclaw.connected: false when the gateway client is disconnected", async () => {
      openClawConnectionState.connected = false;

      const request = new NextRequest("http://localhost/api/health", { method: "GET" });
      const response = await GET(request);
      const data = await response.json();

      expect(data.openclaw).toEqual({ connected: false });
    });

    it("keeps top-level status 'ok' and HTTP 200 even when the gateway is disconnected", async () => {
      // Deliberate: brief disconnects during config.apply-triggered OpenClaw
      // restarts are expected. Flipping status here would make the Docker
      // healthcheck restart-loop the container during normal operation.
      openClawConnectionState.connected = false;

      const request = new NextRequest("http://localhost/api/health", { method: "GET" });
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("ok");
    });
  });
});
