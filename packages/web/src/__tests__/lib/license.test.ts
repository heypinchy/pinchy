// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from "vitest";
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

async function createTestToken(claims: Record<string, unknown> = {}, expiresIn = "14d") {
  return new jose.SignJWT({
    type: "trial",
    features: ["enterprise"],
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("heypinchy.com")
    .setSubject("test-org")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(testPrivateKey);
}

describe("validateLicense", () => {
  it("returns active=true for a valid token", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken();
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.active).toBe(true);
    expect(status.type).toBe("trial");
    expect(status.org).toBe("test-org");
    expect(status.features).toEqual(["enterprise"]);
    expect(status.expiresAt).toBeInstanceOf(Date);
    expect(status.daysRemaining).toBeGreaterThan(0);
  });

  it("returns active=false for an expired token", async () => {
    const { validateLicense } = await import("@/lib/license");
    // jose checks exp against the current clock — advance the system clock
    // past the token's expiry instead of waiting in real time.
    vi.useFakeTimers();
    try {
      const token = await createTestToken({}, "1s");
      vi.setSystemTime(Date.now() + 1500);
      const status = await validateLicense(token, testPublicKeyPem);
      expect(status.active).toBe(false);
      expect(status.features).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns active=false for an invalid signature", async () => {
    const { validateLicense } = await import("@/lib/license");
    const { privateKey: wrongKey } = await jose.generateKeyPair("ES256", {
      extractable: true,
    });
    const token = await new jose.SignJWT({
      type: "trial",
      features: ["enterprise"],
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("heypinchy.com")
      .setSubject("test-org")
      .setIssuedAt()
      .setExpirationTime("14d")
      .sign(wrongKey);

    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.active).toBe(false);
  });

  it("returns active=false for a malformed token", async () => {
    const { validateLicense } = await import("@/lib/license");
    const status = await validateLicense("not-a-jwt", testPublicKeyPem);
    expect(status.active).toBe(false);
  });

  it("returns active=false for an empty token", async () => {
    const { validateLicense } = await import("@/lib/license");
    const status = await validateLicense("", testPublicKeyPem);
    expect(status.active).toBe(false);
  });

  it("calculates daysRemaining correctly", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({}, "7d");
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.daysRemaining).toBeGreaterThanOrEqual(6);
    expect(status.daysRemaining).toBeLessThanOrEqual(7);
  });

  it("returns type from token claims", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({ type: "paid" }, "365d");
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.type).toBe("paid");
  });

  it("returns active=false when features does not include enterprise", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({ features: ["something-else"] });
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.active).toBe(false);
  });

  it("extracts ver and maxUsers from token claims", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({ ver: 1, maxUsers: 10 });
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.ver).toBe(1);
    expect(status.maxUsers).toBe(10);
  });

  it("defaults ver to 1 when missing from token", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({});
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.ver).toBe(1);
  });

  it("defaults maxUsers to 0 (unlimited) when missing from token", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({});
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.maxUsers).toBe(0);
  });

  it("validates tokens with higher ver (forward compat)", async () => {
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({ ver: 2, maxUsers: 5 });
    const status = await validateLicense(token, testPublicKeyPem);
    expect(status.active).toBe(true);
    expect(status.ver).toBe(2);
    expect(status.maxUsers).toBe(5);
  });

  it("logs a warning for tokens with unknown higher ver", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { validateLicense } = await import("@/lib/license");
    const token = await createTestToken({ ver: 2 });
    await validateLicense(token, testPublicKeyPem);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ver=2"));
    warnSpy.mockRestore();
  });

  it("INACTIVE result has ver=1 and maxUsers=0 defaults", async () => {
    const { validateLicense } = await import("@/lib/license");
    const status = await validateLicense("", testPublicKeyPem);
    expect(status.active).toBe(false);
    expect(status.ver).toBe(1);
    expect(status.maxUsers).toBe(0);
  });
});
