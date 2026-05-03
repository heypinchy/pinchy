import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  migrateSessionKeys: vi.fn(),
  loadDomainCache: vi.fn().mockResolvedValue(undefined),
  migrateToSecretRef: vi.fn(),
  migrateGatewayTokenToDb: vi.fn().mockResolvedValue(undefined),
  sanitizeOpenClawConfig: vi.fn().mockReturnValue(false),
  isSetupComplete: vi.fn().mockResolvedValue(true),
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
  markOpenClawConfigReady: vi.fn(),
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
vi.mock("@/lib/openclaw-config-ready", () => ({
  markOpenClawConfigReady: mocks.markOpenClawConfigReady,
}));

describe("bootInits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDomainCache.mockResolvedValue(undefined);
    mocks.migrateGatewayTokenToDb.mockResolvedValue(undefined);
    mocks.sanitizeOpenClawConfig.mockReturnValue(false);
    mocks.isSetupComplete.mockResolvedValue(true);
    mocks.migrateExistingSmithers.mockResolvedValue(undefined);
    mocks.regenerateOpenClawConfig.mockResolvedValue(undefined);
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
    expect(mocks.regenerateOpenClawConfig).toHaveBeenCalledOnce();
    expect(mocks.markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("calls migrateExistingSmithers before regenerateOpenClawConfig", async () => {
    const callOrder: string[] = [];
    mocks.migrateExistingSmithers.mockImplementation(async () => {
      callOrder.push("migrateExistingSmithers");
    });
    mocks.regenerateOpenClawConfig.mockImplementation(async () => {
      callOrder.push("regenerateOpenClawConfig");
    });

    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(callOrder).toEqual(["migrateExistingSmithers", "regenerateOpenClawConfig"]);
  });

  it("calls regenerateOpenClawConfig exactly once", async () => {
    const { bootInits } = await import("@/lib/boot-inits");
    await bootInits();

    expect(mocks.regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
  });

  it("returns false and skips regenerate when setup is incomplete", async () => {
    mocks.isSetupComplete.mockResolvedValue(false);

    const { bootInits } = await import("@/lib/boot-inits");
    const result = await bootInits();

    expect(result).toBe(false);
    expect(mocks.migrateExistingSmithers).not.toHaveBeenCalled();
    expect(mocks.regenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(mocks.markOpenClawConfigReady).not.toHaveBeenCalled();
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
