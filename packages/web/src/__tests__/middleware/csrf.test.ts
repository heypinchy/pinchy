import { describe, it, expect } from "vitest";
import { isCsrfRequestAllowed } from "@/server/csrf-check";

describe("CSRF check", () => {
  describe("safe methods", () => {
    it("allows GET regardless of headers", () => {
      expect(
        isCsrfRequestAllowed({
          method: "GET",
          pathname: "/api/agents",
          origin: "https://evil.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });

    it("allows HEAD regardless of headers", () => {
      expect(
        isCsrfRequestAllowed({
          method: "HEAD",
          pathname: "/api/agents",
          origin: "https://evil.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });

    it("allows OPTIONS regardless of headers", () => {
      expect(
        isCsrfRequestAllowed({
          method: "OPTIONS",
          pathname: "/api/agents",
          origin: "https://evil.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });
  });

  describe("non-API routes", () => {
    it("allows POST to non-/api/ paths (handled by Next.js form actions etc.)", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/login",
          origin: "https://evil.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });
  });

  describe("Better Auth routes", () => {
    it("exempts /api/auth/* (Better Auth has its own trustedOrigins check)", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/auth/sign-in/email",
          origin: "https://evil.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });
  });

  describe("Origin header check", () => {
    it("allows POST when Origin matches request host (https)", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "https://pinchy.example.com",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });

    it("allows POST when Origin matches request host (http)", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "http://localhost:7777",
          referer: undefined,
          host: "localhost:7777",
          forwardedProto: "http",
        })
      ).toEqual({ allowed: true });
    });

    it("blocks POST when Origin is a different domain", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "https://evil.example.com",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/origin/i);
      }
    });

    it("blocks POST when Origin is the same host but wrong scheme", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "http://pinchy.example.com",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("blocks POST when Origin has a different port", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "https://pinchy.example.com:8443",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("treats explicit default port :443 as equivalent to no port", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "https://pinchy.example.com:443",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });

    it("treats explicit default port :80 as equivalent to no port", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "http://pinchy.example.com:80",
          referer: undefined,
          host: "pinchy.example.com",
          forwardedProto: "http",
        })
      ).toEqual({ allowed: true });
    });

    it("blocks Origin: null (sandboxed iframe / cross-origin redirect)", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "null",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("Referer fallback", () => {
    it("falls back to Referer when Origin is absent and matches host", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: undefined,
          referer: "https://pinchy.example.com/agents",
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });

    it("blocks when Origin is absent and Referer is cross-origin", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: undefined,
        referer: "https://evil.example.com/exploit",
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/referer/i);
      }
    });

    it("blocks when both Origin and Referer are absent", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: undefined,
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("ignores Referer when Origin is present and valid", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "https://pinchy.example.com",
          referer: "https://evil.example.com/exploit",
          host: "pinchy.example.com",
          forwardedProto: "https",
        })
      ).toEqual({ allowed: true });
    });
  });

  describe("methods", () => {
    it("checks PUT", () => {
      const result = isCsrfRequestAllowed({
        method: "PUT",
        pathname: "/api/agents/abc",
        origin: "https://evil.example.com",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("checks PATCH", () => {
      const result = isCsrfRequestAllowed({
        method: "PATCH",
        pathname: "/api/agents/abc",
        origin: "https://evil.example.com",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("checks DELETE", () => {
      const result = isCsrfRequestAllowed({
        method: "DELETE",
        pathname: "/api/agents/abc",
        origin: "https://evil.example.com",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("forwardedProto fallback", () => {
    it("defaults to http when forwardedProto is undefined", () => {
      expect(
        isCsrfRequestAllowed({
          method: "POST",
          pathname: "/api/agents",
          origin: "http://localhost:7777",
          referer: undefined,
          host: "localhost:7777",
          forwardedProto: undefined,
        })
      ).toEqual({ allowed: true });
    });
  });

  describe("malformed input", () => {
    it("blocks when host is missing (cannot validate)", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "https://pinchy.example.com",
        referer: undefined,
        host: undefined,
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });

    it("blocks when Origin is not a valid URL", () => {
      const result = isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "not-a-url",
        referer: undefined,
        host: "pinchy.example.com",
        forwardedProto: "https",
      });
      expect(result.allowed).toBe(false);
    });
  });
});
