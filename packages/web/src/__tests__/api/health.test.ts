import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";
import { openClawConnectionState } from "@/server/openclaw-connection-state";
import { recordConfigRegenSuccess, recordConfigRegenFailure } from "@/lib/openclaw-config-health";

const REGEN_STATE_KEY = "__pinchyOpenClawConfigRegenState";

describe("GET /api/health", () => {
  const originalConnected = openClawConnectionState.connected;

  beforeEach(() => {
    openClawConnectionState.connected = false;
    delete (globalThis as Record<string, unknown>)[REGEN_STATE_KEY];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    openClawConnectionState.connected = originalConnected;
    delete (globalThis as Record<string, unknown>)[REGEN_STATE_KEY];
  });

  it("should return 200 with status ok", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ status: "ok" });
  });

  it("should return JSON content type", async () => {
    const response = await GET();
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

    const response = await GET();
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

      const response = await GET();
      const data = await response.json();

      expect(data.openclaw).toEqual({ connected: true });
    });

    it("reports openclaw.connected: false when the gateway client is disconnected", async () => {
      openClawConnectionState.connected = false;

      const response = await GET();
      const data = await response.json();

      expect(data.openclaw).toEqual({ connected: false });
    });

    it("keeps top-level status 'ok' and HTTP 200 even when the gateway is disconnected", async () => {
      // Deliberate: brief disconnects during config.apply-triggered OpenClaw
      // restarts are expected. Flipping status here would make the Docker
      // healthcheck restart-loop the container during normal operation.
      openClawConnectionState.connected = false;

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("ok");
    });
  });

  // Issue #879: readiness is marked even when the boot regenerate throws, so
  // /api/health must expose the regeneration outcome — otherwise a frozen
  // config (e.g. #878 missing-secrets-volume EACCES) is completely invisible
  // to monitoring while the instance reports healthy.
  describe("config regeneration outcome (#879)", () => {
    it("reports configRegeneration ok when nothing has failed", async () => {
      const response = await GET();
      const data = await response.json();

      expect(data.configRegeneration).toMatchObject({ ok: true });
    });

    it("surfaces a recorded regeneration failure with its actionable message", async () => {
      recordConfigRegenFailure("your docker-compose.yml is missing the openclaw-secrets volume");

      const response = await GET();
      const data = await response.json();

      expect(data.configRegeneration.ok).toBe(false);
      expect(data.configRegeneration.error).toMatch(/openclaw-secrets volume/);
    });

    it("clears the failure once a later regeneration succeeds", async () => {
      recordConfigRegenFailure("broken");
      recordConfigRegenSuccess();

      const response = await GET();
      const data = await response.json();

      expect(data.configRegeneration.ok).toBe(true);
      expect(data.configRegeneration.error).toBeUndefined();
    });

    it("keeps top-level status 'ok' and HTTP 200 even when regeneration failed", async () => {
      // Same rationale as the gateway-disconnect case: the boolean is for
      // monitoring, not for flipping the Docker healthcheck into a restart loop.
      recordConfigRegenFailure("broken");

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.configRegeneration.ok).toBe(false);
    });
  });
});
