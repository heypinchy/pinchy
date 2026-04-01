import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Auth HTTP/HTTPS configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isHttps detection", () => {
    it("should be false when BETTER_AUTH_URL is not set", async () => {
      delete process.env.BETTER_AUTH_URL;
      const mod = await import("@/lib/auth");
      // The auth module doesn't export isHttps directly, but we can verify
      // the behavior through the config. If useSecureCookies is false, isHttps is false.
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("should be false when BETTER_AUTH_URL starts with http://", async () => {
      process.env.BETTER_AUTH_URL = "http://pinchy.example.com";
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(false);
    });

    it("should be true when BETTER_AUTH_URL starts with https://", async () => {
      process.env.BETTER_AUTH_URL = "https://pinchy.example.com";
      const mod = await import("@/lib/auth");
      expect(mod.auth.options.advanced?.useSecureCookies).toBe(true);
    });
  });

  describe("trustedOrigins", () => {
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
});
