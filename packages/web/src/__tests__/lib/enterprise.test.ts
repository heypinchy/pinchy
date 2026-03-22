// @vitest-environment node
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import * as jose from "jose";

let testPublicKeyPem: string;
let testPrivateKey: CryptoKey;

beforeAll(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  testPublicKeyPem = await jose.exportSPKI(publicKey);
  testPrivateKey = privateKey;
});

async function createTestToken(overrides: Record<string, unknown> = {}, expiresIn = "14d") {
  return new jose.SignJWT({
    type: "trial",
    features: ["enterprise"],
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("heypinchy.com")
    .setSubject("test-org")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(testPrivateKey);
}

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

import { getSetting } from "@/lib/settings";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PINCHY_ENTERPRISE_KEY;
  vi.resetModules();
});

describe("getLicenseStatus", () => {
  it("returns active status for valid env var token", async () => {
    const token = await createTestToken();
    process.env.PINCHY_ENTERPRISE_KEY = token;

    const mod = await import("@/lib/enterprise");
    const status = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status.active).toBe(true);
    expect(status.type).toBe("trial");
    expect(status.org).toBe("test-org");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("env var takes priority over DB key", async () => {
    const envToken = await createTestToken({ type: "trial" });
    process.env.PINCHY_ENTERPRISE_KEY = envToken;

    const mod = await import("@/lib/enterprise");
    const status = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status.active).toBe(true);
    expect(status.type).toBe("trial");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("isKeyFromEnv returns true when env var is set", async () => {
    process.env.PINCHY_ENTERPRISE_KEY = "some-key";
    const mod = await import("@/lib/enterprise");
    expect(mod.isKeyFromEnv()).toBe(true);
  });

  it("isKeyFromEnv returns false when no env var", async () => {
    const mod = await import("@/lib/enterprise");
    expect(mod.isKeyFromEnv()).toBe(false);
  });

  it("falls back to DB setting when no env var", async () => {
    const token = await createTestToken({ type: "paid" }, "365d");
    vi.mocked(getSetting).mockResolvedValueOnce(token);

    const mod = await import("@/lib/enterprise");
    const status = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status.active).toBe(true);
    expect(status.type).toBe("paid");
    expect(getSetting).toHaveBeenCalledWith("enterprise_key");
  });

  it("returns inactive when no token anywhere", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const mod = await import("@/lib/enterprise");
    const status = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status.active).toBe(false);
  });

  it("caches result for subsequent calls", async () => {
    const token = await createTestToken();
    process.env.PINCHY_ENTERPRISE_KEY = token;

    const mod = await import("@/lib/enterprise");
    const status1 = await mod.getLicenseStatus(testPublicKeyPem);
    const status2 = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status1).toBe(status2); // Same object reference = cached
  });

  it("clearLicenseCache forces re-evaluation", async () => {
    const token = await createTestToken();
    process.env.PINCHY_ENTERPRISE_KEY = token;

    const mod = await import("@/lib/enterprise");
    const status1 = await mod.getLicenseStatus(testPublicKeyPem);
    mod.clearLicenseCache();
    const status2 = await mod.getLicenseStatus(testPublicKeyPem);
    expect(status1).not.toBe(status2);
    expect(status2.active).toBe(true);
  });
});

describe("isEnterprise", () => {
  it("returns true when license is active", async () => {
    const token = await createTestToken();
    process.env.PINCHY_ENTERPRISE_KEY = token;

    const mod = await import("@/lib/enterprise");
    const result = await mod.isEnterprise(testPublicKeyPem);
    expect(result).toBe(true);
  });

  it("returns false when no valid license", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(null);

    const mod = await import("@/lib/enterprise");
    const result = await mod.isEnterprise(testPublicKeyPem);
    expect(result).toBe(false);
  });
});
