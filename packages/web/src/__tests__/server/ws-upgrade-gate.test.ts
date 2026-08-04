import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return { ...actual, getCachedDomain: vi.fn() };
});

import { isWsUpgradeAllowed, readWsUpgradeCheckInput } from "@/server/ws-upgrade-gate";
import { getCachedDomain } from "@/lib/domain-cache";
import type { IncomingMessage } from "http";

function mockedDomain(domain: string | null) {
  vi.mocked(getCachedDomain).mockReturnValue(domain);
}

describe("isWsUpgradeAllowed", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReset();
  });

  describe("no domain lock configured", () => {
    beforeEach(() => mockedDomain(null));

    it("allows an upgrade with no Origin header (non-browser caller)", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: undefined,
      });
      expect(result).toEqual({ allowed: true });
    });

    it("allows an upgrade whose Origin matches the request host", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: "https://pinchy.example.com",
      });
      expect(result).toEqual({ allowed: true });
    });

    it("rejects an upgrade whose Origin host does not match the request host", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: "https://evil.example.com",
      });
      expect(result).toEqual({ allowed: false, reason: "origin-mismatch" });
    });

    it("rejects an unparseable Origin header", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: "not-a-url",
      });
      expect(result).toEqual({ allowed: false, reason: "origin-mismatch" });
    });
  });

  describe("domain lock active", () => {
    beforeEach(() => mockedDomain("pinchy.example.com"));

    it("rejects an upgrade addressed to a foreign host", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "203.0.113.42",
        origin: undefined,
      });
      expect(result).toEqual({ allowed: false, reason: "domain-lock" });
    });

    it("allows an upgrade addressed to the locked domain, with a matching Origin", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: "https://pinchy.example.com",
      });
      expect(result).toEqual({ allowed: true });
    });

    it("still rejects a same-host, cross-origin upgrade after the domain-lock check passes", () => {
      const result = isWsUpgradeAllowed({
        pathname: "/api/ws",
        host: "pinchy.example.com",
        origin: "https://evil.example.com",
      });
      expect(result).toEqual({ allowed: false, reason: "origin-mismatch" });
    });

    it("lets a plugin's Docker-internal upgrade through unaffected (same exemptions as the HTTP gate)", () => {
      // /api/internal/* bypasses host matching entirely (host-check.ts). No
      // plugin actually opens a WS upgrade against that prefix today, but the
      // reused isHostAllowed must behave identically either way.
      const result = isWsUpgradeAllowed({
        pathname: "/api/internal/some-plugin-path",
        host: "pinchy:7777",
        origin: undefined,
      });
      expect(result).toEqual({ allowed: true });
    });
  });
});

describe("readWsUpgradeCheckInput", () => {
  function makeRequest(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it("reads host and origin off the raw request", () => {
    const input = readWsUpgradeCheckInput(
      makeRequest({ host: "pinchy.example.com", origin: "https://pinchy.example.com" }),
      "/api/ws"
    );
    expect(input).toEqual({
      pathname: "/api/ws",
      host: "pinchy.example.com",
      origin: "https://pinchy.example.com",
    });
  });

  it("prefers x-forwarded-host over host (proxy-aware, matching the HTTP gates)", () => {
    const input = readWsUpgradeCheckInput(
      makeRequest({ host: "internal:7777", "x-forwarded-host": "pinchy.example.com" }),
      "/api/ws"
    );
    expect(input.host).toBe("pinchy.example.com");
  });

  it("leaves origin undefined when no Origin header is present", () => {
    const input = readWsUpgradeCheckInput(makeRequest({ host: "pinchy.example.com" }), "/api/ws");
    expect(input.origin).toBeUndefined();
  });
});
