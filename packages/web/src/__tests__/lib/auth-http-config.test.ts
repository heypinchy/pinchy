import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain", () => ({
  getCachedDomain: vi.fn(),
}));

describe("Auth HTTP/HTTPS configuration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("useSecureCookies", () => {
    it("should be false when no domain is cached", async () => {
      const { getCachedDomain } = await import("@/lib/domain");
      vi.mocked(getCachedDomain).mockReturnValue(null);
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("should be true when a domain is cached", async () => {
      const { getCachedDomain } = await import("@/lib/domain");
      vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(true);
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
