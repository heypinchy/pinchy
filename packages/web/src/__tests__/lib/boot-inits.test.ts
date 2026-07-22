import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  migrateSessionKeys: vi.fn(),
  loadDomainCache: vi.fn().mockResolvedValue(undefined),
  migrateToSecretRef: vi.fn(),
  migrateGatewayTokenToDb: vi.fn().mockResolvedValue(undefined),
  sanitizeOpenClawConfig: vi.fn().mockReturnValue(false),
  isSetupComplete: vi.fn().mockResolvedValue(true),
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
  migrateSmithersSoul: vi.fn().mockResolvedValue(undefined),
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
  markOpenClawConfigReady: vi.fn(),
  checkSecretsVolumeWritable: vi.fn().mockReturnValue({ ok: true }),
  recordConfigRegenSuccess: vi.fn(),
  recordConfigRegenFailure: vi.fn(),
}));

vi.mock("@/lib/session-migration", () => ({ migrateSessionKeys: mocks.migrateSessionKeys }));
vi.mock("@/lib/domain", () => ({ loadDomainCache: mocks.loadDomainCache }));
vi.mock("@/lib/openclaw-migration", () => ({ migrateToSecretRef: mocks.migrateToSecretRef }));
vi.mock("@/lib/migrate-gateway-token", () => ({
  migrateGatewayTokenToDb: mocks.migrateGatewayTokenToDb,
}));
vi.mock("@/lib/openclaw-config", () => ({
  sanitizeOpenClawConfig: mocks.sanitizeOpenClawConfig,
  regenerateOpenClawConfig: mocks.regenerateOpenClawConfig,
}));
vi.mock("@/lib/setup", () => ({ isSetupComplete: mocks.isSetupComplete }));
vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: mocks.migrateExistingSmithers,
}));
vi.mock("@/lib/migrate-smithers-soul", () => ({
  migrateSmithersSoul: mocks.migrateSmithersSoul,
}));
vi.mock("@/lib/openclaw-config-ready", () => ({
  markOpenClawConfigReady: mocks.markOpenClawConfigReady,
}));
vi.mock("@/lib/openclaw-secrets", () => ({
  checkSecretsVolumeWritable: mocks.checkSecretsVolumeWritable,
}));
vi.mock("@/lib/openclaw-config-health", () => ({
  recordConfigRegenSuccess: mocks.recordConfigRegenSuccess,
  recordConfigRegenFailure: mocks.recordConfigRegenFailure,
}));

describe("bootInits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDomainCache.mockResolvedValue(undefined);
    mocks.migrateGatewayTokenToDb.mockResolvedValue(undefined);
    mocks.sanitizeOpenClawConfig.mockReturnValue(false);
    mocks.isSetupComplete.mockResolvedValue(true);
    mocks.migrateExistingSmithers.mockResolvedValue(undefined);
    mocks.migrateSmithersSoul.mockResolvedValue(undefined);
    mocks.regenerateOpenClawConfig.mockResolvedValue(undefined);
    mocks.checkSecretsVolumeWritable.mockReturnValue({ ok: true });
  });

  it("runs all boot inits when setup is complete", async () => {
    const { bootInits } = await import("@/lib/boot-inits");
    const result = await bootInits();

    expect(result).toBe(true);
    expect(mocks.migrateSessionKeys).toHaveBeenCalledOnce();
    expect(mocks.loadDomainCache).toHaveBeenCalledOnce();
    expect(mocks.migrateToSecretRef).toHaveBeenCalledOnce();
    expect(mocks.migrateGatewayTokenToDb).toHaveBeenCalledOnce();
    expect(mocks.sanitizeOpenClawConfig).toHaveBeenCalledOnce();
    expect(mocks.migrateExistingSmithers).toHaveBeenCalledOnce();
    expect(mocks.migrateSmithersSoul).toHaveBeenCalledOnce();
    expect(mocks.regenerateOpenClawConfig).toHaveBeenCalledOnce();
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("calls migrateExistingSmithers before regenerateOpenClawConfig", async () => {
    const callOrder: string[] = [];
    mocks.migrateExistingSmithers.mockImplementation(async () => {
      callOrder.push("migrateExistingSmithers");
    });
    mocks.migrateSmithersSoul.mockImplementation(async () => {
      callOrder.push("migrateSmithersSoul");
    });
    mocks.regenerateOpenClawConfig.mockImplementation(async () => {
      callOrder.push("regenerateOpenClawConfig");
    });

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(callOrder).toEqual([
      "migrateExistingSmithers",
      "migrateSmithersSoul",
      "regenerateOpenClawConfig",
    ]);
  });

  it("still regenerates the config when the soul migration throws", async () => {
    // SOUL.md drift is cosmetic next to a stale openclaw.json. The soul
    // migration gets its own try/catch precisely so a broken workspace volume
    // cannot cost the instance its config regeneration — and with it a working
    // OpenClaw. Without the nested catch, `result` here would be false.
    mocks.migrateSmithersSoul.mockRejectedValue(new Error("workspace volume gone"));

    const { bootInits } = await import("@/lib/boot-inits");
    const result = await bootInits();

    expect(result).toBe(true);
    expect(mocks.regenerateOpenClawConfig).toHaveBeenCalledOnce();
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("calls regenerateOpenClawConfig exactly once", async () => {
    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
  });

  it("returns false and skips regenerate when setup is incomplete, but still marks ready", async () => {
    // markOpenClawConfigReady() must be called unconditionally so that the
    // Docker Compose healthcheck can pass and OpenClaw can start even on a
    // fresh install that hasn't run setup yet.
    mocks.isSetupComplete.mockResolvedValue(false);

    const { bootInits } = await import("@/lib/boot-inits");
    const result = await bootInits();

    expect(result).toBe(false);
    expect(mocks.migrateExistingSmithers).not.toHaveBeenCalled();
    expect(mocks.migrateSmithersSoul).not.toHaveBeenCalled();
    expect(mocks.regenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("still calls markOpenClawConfigReady when regenerateOpenClawConfig throws", async () => {
    mocks.regenerateOpenClawConfig.mockRejectedValue(new Error("EACCES: permission denied"));

    const { bootInits } = await import("@/lib/boot-inits");
    const result = await bootInits();

    expect(result).toBe(false);
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  // #879: readiness is marked even when the boot regenerate throws (OpenClaw
  // must be able to start), so the failure must be recorded separately for
  // /api/health — otherwise the instance reports healthy while its config
  // generation is broken.
  it("records a config-regeneration failure when regenerate throws, without blocking readiness", async () => {
    mocks.regenerateOpenClawConfig.mockRejectedValue(new Error("EACCES: permission denied"));

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.recordConfigRegenFailure).toHaveBeenCalledWith(
      expect.stringContaining("EACCES: permission denied")
    );
    expect(mocks.recordConfigRegenSuccess).not.toHaveBeenCalled();
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("records a config-regeneration success when the boot regenerate completes", async () => {
    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.recordConfigRegenSuccess).toHaveBeenCalledOnce();
    expect(mocks.recordConfigRegenFailure).not.toHaveBeenCalled();
  });

  it("records a config-regeneration failure when the secrets-volume preflight fails", async () => {
    // Even with setup incomplete (regenerate skipped), a broken volume must
    // surface in health — the preflight records it directly.
    mocks.isSetupComplete.mockResolvedValue(false);
    mocks.checkSecretsVolumeWritable.mockReturnValue({
      ok: false,
      message: "docker-compose.yml is missing the openclaw-secrets volume",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.recordConfigRegenFailure).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-secrets volume")
    );
    expect(mocks.regenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(mocks.recordConfigRegenSuccess).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("logs the actionable secrets-volume message loudly when the volume is not writable", async () => {
    // #878: an image-only upgrade drops the openclaw-secrets mount. The preflight
    // must surface the actionable cause, not let the bare EACCES hide inside the
    // generic "Failed to regenerate" catch.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.checkSecretsVolumeWritable.mockReturnValue({
      ok: false,
      message: "your docker-compose.yml is missing the openclaw-secrets volume",
    });

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/OpenClaw secrets volume is not writable/);
    expect(logged).toMatch(/docker-compose\.yml is missing the openclaw-secrets volume/);
    // Preflight is a loud warning, not a boot-blocker: the instance still comes
    // up so the operator can fix the compose file and OpenClaw can start.
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });

  it("does not log the secrets-volume error when the volume is writable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toMatch(/OpenClaw secrets volume is not writable/);

    errorSpy.mockRestore();
  });

  it("still runs non-critical migrations when setup is incomplete", async () => {
    mocks.isSetupComplete.mockResolvedValue(false);

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.migrateSessionKeys).toHaveBeenCalledOnce();
    expect(mocks.loadDomainCache).toHaveBeenCalledOnce();
    expect(mocks.migrateGatewayTokenToDb).toHaveBeenCalledOnce();
    expect(mocks.sanitizeOpenClawConfig).toHaveBeenCalledOnce();
  });
});
