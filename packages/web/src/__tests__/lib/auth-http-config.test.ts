import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain", () => ({
  getCachedDomain: vi.fn(),
}));

vi.mock("@/lib/secure-cookies", () => ({
  shouldUseSecureCookies: vi.fn(),
}));

describe("Auth HTTP/HTTPS configuration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("useSecureCookies", () => {
    it("is false when not in secure (domain-locked) mode", async () => {
      const { shouldUseSecureCookies } = await import("@/lib/secure-cookies");
      vi.mocked(shouldUseSecureCookies).mockReturnValue(false);
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("is true in secure (domain-locked) mode", async () => {
      const { shouldUseSecureCookies } = await import("@/lib/secure-cookies");
      vi.mocked(shouldUseSecureCookies).mockReturnValue(true);
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(true);
    });

    it("does NOT depend on the async domain cache (regression: the cookie-name flip)", async () => {
      // The bug: useSecureCookies read getCachedDomain() at import time, which is
      // cold/nondeterministic, so the value — and Better Auth's `__Secure-`
      // cookie NAME — flipped between deploys and logged users out. It must now
      // come solely from the stable sync flag: even with the domain cache cold
      // (null), a locked flag decides.
      const { getCachedDomain } = await import("@/lib/domain");
      const { shouldUseSecureCookies } = await import("@/lib/secure-cookies");
      vi.mocked(getCachedDomain).mockReturnValue(null);
      vi.mocked(shouldUseSecureCookies).mockReturnValue(true);
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(true);
    });
  });

  describe("session cookie attributes", () => {
    // The WS upgrade path's Origin check (ws-upgrade-gate.ts) is deliberately
    // permissive about a *missing* Origin, so the session cookie's SameSite
    // attribute carries real weight in the defense-in-depth against
    // cross-site WebSocket hijacking. It is pinned explicitly rather than left
    // to Better Auth's implicit default, so a dependency bump can't silently
    // change it. "lax" (not "strict") preserves today's behavior — "strict"
    // would drop the cookie on legitimate top-level-navigation flows, e.g. an
    // email verification link landing the user on an authenticated page.
    //
    // These read the *resolved* cookie rather than `options.advanced`: Better
    // Auth spreads defaultCookieAttributes over its own defaults, so a value
    // declared there is not proof of a value on the wire, and an attributes
    // object that quietly dropped httpOnly/secure would read as configured
    // either way. Same distinction as the X-Frame-Options gate — assert what a
    // concrete request resolves to, not what the config asked for.
    async function resolvedSessionCookie(secure: boolean) {
      const { shouldUseSecureCookies } = await import("@/lib/secure-cookies");
      vi.mocked(shouldUseSecureCookies).mockReturnValue(secure);
      const [{ auth }, { getCookies }] = await Promise.all([
        import("@/lib/auth"),
        import("better-auth/cookies"),
      ]);
      return getCookies(auth.options).sessionToken.attributes;
    }

    it("resolves to SameSite=Lax, HttpOnly in insecure mode", async () => {
      const attributes = await resolvedSessionCookie(false);
      expect(attributes.sameSite).toBe("lax");
      expect(attributes.httpOnly).toBe(true);
      expect(attributes.secure).toBe(false);
    });

    it("stays SameSite=Lax, HttpOnly and gains Secure in domain-locked mode", async () => {
      const attributes = await resolvedSessionCookie(true);
      expect(attributes.sameSite).toBe("lax");
      expect(attributes.httpOnly).toBe(true);
      expect(attributes.secure).toBe(true);
    });
  });

  describe("trustedOrigins", () => {
    describe("when no domain is cached (insecure mode)", () => {
      beforeEach(async () => {
        const { getCachedDomain } = await import("@/lib/domain");
        vi.mocked(getCachedDomain).mockReturnValue(null);
      });

      it("should be configured as a function", async () => {
        const mod = await import("@/lib/auth");
        expect(typeof mod.auth.options.trustedOrigins).toBe("function");
      });

      it("should extract origin from host header", async () => {
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost", {
          headers: { host: "pinchy.example.com" },
        });
        const origins = fn(req);
        expect(origins).toContain("http://pinchy.example.com");
      });

      it("should prefer x-forwarded-host over host header", async () => {
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost", {
          headers: {
            host: "internal:7777",
            "x-forwarded-host": "pinchy.example.com",
          },
        });
        const origins = fn(req);
        expect(origins).toContain("http://pinchy.example.com");
      });

      it("should use x-forwarded-proto for protocol", async () => {
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost", {
          headers: {
            host: "pinchy.example.com",
            "x-forwarded-proto": "https",
          },
        });
        const origins = fn(req);
        expect(origins).toContain("https://pinchy.example.com");
      });

      it("should default to http when x-forwarded-proto is missing", async () => {
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost", {
          headers: { host: "91.98.202.16" },
        });
        const origins = fn(req);
        expect(origins).toContain("http://91.98.202.16");
      });

      it("should return empty array when no host header exists", async () => {
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost");
        const origins = fn(req);
        expect(origins).toEqual([]);
      });
    });

    describe("when domain is cached (secure mode)", () => {
      it("should only trust the locked domain over HTTPS", async () => {
        const { getCachedDomain } = await import("@/lib/domain");
        vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost", {
          headers: { host: "evil.example.com" },
        });
        const origins = fn(req);
        expect(origins).toEqual(["https://pinchy.example.com"]);
      });

      it("should include port in trusted origin when domain has port", async () => {
        const { getCachedDomain } = await import("@/lib/domain");
        vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com:8443");
        const mod = await import("@/lib/auth");
        const fn = mod.auth.options.trustedOrigins as (req?: Request) => string[];
        const req = new Request("http://localhost");
        const origins = fn(req);
        expect(origins).toEqual(["https://pinchy.example.com:8443"]);
      });
    });
  });
});
