// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as jose from "jose";

const ENTERPRISE_SOURCE = resolve(__dirname, "../../lib/enterprise.ts");

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
  // reset, not clear: `clearAllMocks` keeps implementations, so a test that
  // sets a lasting `mockResolvedValue` (the agreement loop below does) would
  // hand its last token to every test after it. Nothing breaks today, which is
  // exactly what makes it worth removing — `getSetting` is declared as a bare
  // `vi.fn()`, so resetting restores the state each test already assumes.
  vi.resetAllMocks();
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

// One Pinchy process loads this module twice: once for the custom server
// (`server.ts` → ClientRouter, the WS chat path) and once for Next's route
// bundles (`PUT /api/enterprise/key`, which clears the cache after saving a
// key). A module-level cache gave each its own copy, so the clear never reached
// the chat server, which kept answering "community" — and treating every
// "restricted" agent as "all" — for up to the 1 h TTL (#1277).
//
// Two instances are simulated with `vi.resetModules()` between two imports.
describe("the license cache is shared by every module instance in the process", () => {
  async function twoInstances() {
    const server = await import("@/lib/enterprise");
    vi.resetModules();
    const route = await import("@/lib/enterprise");
    expect(server).not.toBe(route);
    return [server, route] as const;
  }

  it("a clearLicenseCache() through one instance makes the other re-read the key", async () => {
    const token = await createTestToken();
    let storedKey: string | null = null;
    vi.mocked(getSetting).mockImplementation(async () => storedKey);
    const [server, route] = await twoInstances();

    // The chat server reads the license before anyone entered a key.
    expect((await server.getLicenseStatus(testPublicKeyPem)).active).toBe(false);

    // An admin saves a key; the route clears the cache through ITS instance.
    storedKey = token;
    route.clearLicenseCache();

    // The chat server must see the new license on its next access check.
    expect((await server.getLicenseStatus(testPublicKeyPem)).active).toBe(true);
  });

  it("both instances answer from one cached status", async () => {
    process.env.PINCHY_ENTERPRISE_KEY = await createTestToken();
    const [server, route] = await twoInstances();

    const fromServer = await server.getLicenseStatus(testPublicKeyPem);
    expect(await route.getLicenseStatus(testPublicKeyPem)).toBe(fromServer);
  });

  it("a read that started before a clear does not cache its stale answer", async () => {
    const token = await createTestToken();
    // The first read loads the key while it is still unset, and is held there
    // until the admin's save (and its clear) has happened.
    let releaseStaleRead!: () => void;
    const staleRead = new Promise<void>((resolve) => (releaseStaleRead = resolve));
    let storedKey: string | null = null;
    vi.mocked(getSetting)
      .mockImplementationOnce(async () => {
        const seen = storedKey;
        await staleRead;
        return seen;
      })
      .mockImplementation(async () => storedKey);
    const [server, route] = await twoInstances();

    const inFlight = server.getLicenseStatus(testPublicKeyPem);
    storedKey = token;
    route.clearLicenseCache();
    releaseStaleRead();

    // The in-flight caller still gets the answer it computed …
    expect((await inFlight).active).toBe(false);
    // … but it must not become the cached answer for the next hour.
    expect((await server.getLicenseStatus(testPublicKeyPem)).active).toBe(true);
  });
});

describe("validateLicenseToken", () => {
  it("validates a token without reading or writing settings", async () => {
    const token = await createTestToken({ type: "paid" }, "365d");

    const mod = await import("@/lib/enterprise");
    const status = await mod.validateLicenseToken(token, testPublicKeyPem);

    expect(status.active).toBe(true);
    expect(status.type).toBe("paid");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("returns inactive for a token this build does not trust", async () => {
    const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const foreign = await new jose.SignJWT({ type: "paid", features: ["enterprise"] })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("heypinchy.com")
      .setSubject("other-org")
      .setIssuedAt()
      .setExpirationTime("365d")
      .sign(privateKey);

    const mod = await import("@/lib/enterprise");
    expect((await mod.validateLicenseToken(foreign, testPublicKeyPem)).active).toBe(false);
  });

  it("leaves the cached status untouched", async () => {
    const stored = await createTestToken({ type: "trial" });
    process.env.PINCHY_ENTERPRISE_KEY = stored;

    const mod = await import("@/lib/enterprise");
    const before = await mod.getLicenseStatus(testPublicKeyPem);
    await mod.validateLicenseToken("not-a-token", testPublicKeyPem);
    const after = await mod.getLicenseStatus(testPublicKeyPem);

    // Same object reference — validating a candidate is not a config change,
    // so it must not evict the verdict every gate is reading.
    expect(after).toBe(before);
    expect(after.active).toBe(true);
  });

  // Structural drift pin, and it has to be structural.
  //
  // `PUT /api/enterprise/key` decides with validateLicenseToken what the app
  // then reads through getLicenseStatus. Split those two and the route accepts
  // a key the app treats as community, or refuses one it would honour — and
  // the behavioural test below cannot see it, because it can only feed tokens
  // signed by the one key it generates. A verdict that differs per *key* (a
  // second trusted key, a refused subject — exactly what #1083 adds) is
  // invisible to any fixture written before that key exists.
  //
  // So assert the shape instead: there is one validation path and
  // getLicenseStatus takes it. Verified by canary — point getLicenseStatus at
  // validateLicense directly and this goes red.
  it("has getLicenseStatus validate through validateLicenseToken", () => {
    const source = readFileSync(ENTERPRISE_SOURCE, "utf8");

    // Fail on input this cannot read, rather than on the empty slice it would
    // otherwise produce. `indexOf` answering -1 walks straight through both
    // slices to "", and the report becomes `expected '' to contain
    // 'validateLicenseToken('` — the symptom, with the cause (the function was
    // renamed, or its brace no longer closes at column 0) nowhere in it.
    const start = source.indexOf("export async function getLicenseStatus");
    expect(
      start,
      "no `export async function getLicenseStatus` in lib/enterprise.ts"
    ).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    expect(end, "getLicenseStatus has no closing brace at column 0").toBeGreaterThan(start);

    const fn = source.slice(start, end);
    expect(fn).toContain("validateLicenseToken(");
    expect(fn).not.toContain("validateLicense(");
  });

  // Drift pin: getLicenseStatus and validateLicenseToken must agree, because
  // the license route decides with the second what the app then reads through
  // the first.
  it("agrees with getLicenseStatus on the stored token", async () => {
    for (const token of [
      await createTestToken({ type: "paid" }, "365d"),
      "not-a-token",
      "",
    ] as const) {
      vi.mocked(getSetting).mockResolvedValue(token);

      const mod = await import("@/lib/enterprise");
      // The cache is process-wide (#1277), so a fresh module instance no
      // longer starts empty: clear it as the license route does on a save.
      mod.clearLicenseCache();
      const viaStatus = await mod.getLicenseStatus(testPublicKeyPem);
      const viaValidate = await mod.validateLicenseToken(token, testPublicKeyPem);

      expect(viaValidate).toEqual(viaStatus);
    }
  });
});

// #1083. The development license is committed — that is deliberate, and it is
// only safe because a production build does not trust the key that signed it.
// These two tests are the pair that makes it safe; drop either and the repo is
// back to shipping a key that unlocks paid features on any install.
describe("the shipped development license", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unlocks enterprise outside production", async () => {
    const { DEV_LICENSE_TOKEN } = await import("@/lib/license-keys");
    process.env.PINCHY_ENTERPRISE_KEY = DEV_LICENSE_TOKEN;

    const mod = await import("@/lib/enterprise");
    // No key argument: the real production key plus the development ring,
    // exactly as a running app resolves it.
    const status = await mod.getLicenseStatus();
    expect(status.active).toBe(true);
    expect(status.org).toBe("pinchy-dev");
  });

  it("unlocks nothing in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { DEV_LICENSE_TOKEN } = await import("@/lib/license-keys");
    process.env.PINCHY_ENTERPRISE_KEY = DEV_LICENSE_TOKEN;

    const mod = await import("@/lib/enterprise");
    const status = await mod.getLicenseStatus();
    expect(status.active).toBe(false);
    expect(status.org).toBeUndefined();
    // The production key never saw this signature, so there is nothing to
    // refuse: an unknown key is the community case, exactly as it was before
    // anyone entered one.
    expect(await mod.getLicenseState()).toBe("community");
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
