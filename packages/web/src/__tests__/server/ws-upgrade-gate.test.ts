import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return { ...actual, getCachedDomain: vi.fn() };
});

import {
  isWsUpgradeAllowed,
  readWsUpgradeCheckInput,
  type WsUpgradeCheckInput,
} from "@/server/ws-upgrade-gate";
import { getCachedDomain } from "@/lib/domain-cache";
import type { IncomingMessage } from "http";

function mockedDomain(domain: string | null) {
  vi.mocked(getCachedDomain).mockReturnValue(domain);
}

/**
 * Every field explicit — a default that hides `forwardedProto` would hide the
 * scheme half of the check, which is precisely what this gate got wrong once.
 */
function check(input: Partial<WsUpgradeCheckInput> = {}) {
  return isWsUpgradeAllowed({
    pathname: "/api/ws",
    host: "pinchy.example.com",
    origin: undefined,
    forwardedProto: undefined,
    ...input,
  });
}

describe("isWsUpgradeAllowed", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReset();
  });

  describe("no domain lock configured", () => {
    beforeEach(() => mockedDomain(null));

    it("allows an upgrade with no Origin header (non-browser caller)", () => {
      expect(check({ origin: undefined })).toEqual({ allowed: true });
    });

    it("allows an upgrade whose Origin matches the request host and scheme", () => {
      expect(check({ origin: "https://pinchy.example.com", forwardedProto: "https" })).toEqual({
        allowed: true,
      });
    });

    it("allows a plain-http deployment (no x-forwarded-proto, http Origin)", () => {
      // The dev stack and every Playwright suite: browser on
      // http://localhost:7777, no proxy in front, so no x-forwarded-proto.
      // matchesRequestHost defaults the expected scheme to http for exactly
      // this case — the same defaulting every POST already relies on.
      expect(check({ host: "localhost:7777", origin: "http://localhost:7777" })).toEqual({
        allowed: true,
      });
    });

    it("rejects an upgrade whose Origin host does not match the request host", () => {
      expect(check({ origin: "https://evil.example.com", forwardedProto: "https" })).toEqual({
        allowed: false,
        reason: "origin-mismatch",
      });
    });

    it("rejects an Origin that matches the host but not the scheme", () => {
      // The regression this gate shipped with: a host-only comparison accepted
      // an http:// Origin on an instance the proxy reports as https, where the
      // HTTP CSRF gate rejects it. The two must answer identically.
      expect(check({ origin: "http://pinchy.example.com", forwardedProto: "https" })).toEqual({
        allowed: false,
        reason: "origin-mismatch",
      });
    });

    it("rejects an unparseable Origin header", () => {
      expect(check({ origin: "not-a-url" })).toEqual({
        allowed: false,
        reason: "origin-mismatch",
      });
    });

    it("reports a missing Host header as missing-host, not as an Origin mismatch", () => {
      // The reason string lands in the auth.csrf_blocked audit row, so it has
      // to name what actually happened — same vocabulary as the CSRF gate.
      expect(check({ host: undefined, origin: "https://pinchy.example.com" })).toEqual({
        allowed: false,
        reason: "missing-host",
      });
    });
  });

  describe("domain lock active", () => {
    beforeEach(() => mockedDomain("pinchy.example.com"));

    it("rejects an upgrade addressed to a foreign host", () => {
      expect(check({ host: "203.0.113.42" })).toEqual({
        allowed: false,
        reason: "domain-lock",
      });
    });

    it("allows an upgrade addressed to the locked domain, with a matching Origin", () => {
      expect(check({ origin: "https://pinchy.example.com", forwardedProto: "https" })).toEqual({
        allowed: true,
      });
    });

    it("still rejects a same-host, cross-origin upgrade after the domain-lock check passes", () => {
      expect(check({ origin: "https://evil.example.com", forwardedProto: "https" })).toEqual({
        allowed: false,
        reason: "origin-mismatch",
      });
    });

    it("lets a plugin's Docker-internal upgrade through unaffected (same exemptions as the HTTP gate)", () => {
      // /api/internal/* bypasses host matching entirely (host-check.ts). No
      // plugin actually opens a WS upgrade against that prefix today, but the
      // reused isHostAllowed must behave identically either way.
      expect(check({ pathname: "/api/internal/some-plugin-path", host: "pinchy:7777" })).toEqual({
        allowed: true,
      });
    });
  });
});

describe("readWsUpgradeCheckInput", () => {
  function makeRequest(headers: Record<string, string>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it("reads host, origin and forwarded scheme off the raw request", () => {
    const input = readWsUpgradeCheckInput(
      makeRequest({
        host: "pinchy.example.com",
        origin: "https://pinchy.example.com",
        "x-forwarded-proto": "https",
      }),
      "/api/ws"
    );
    expect(input).toEqual({
      pathname: "/api/ws",
      host: "pinchy.example.com",
      origin: "https://pinchy.example.com",
      forwardedProto: "https",
    });
  });

  it("prefers x-forwarded-host over host (proxy-aware, matching the HTTP gates)", () => {
    const input = readWsUpgradeCheckInput(
      makeRequest({ host: "internal:7777", "x-forwarded-host": "pinchy.example.com" }),
      "/api/ws"
    );
    expect(input.host).toBe("pinchy.example.com");
  });

  it("leaves origin and forwardedProto undefined when the headers are absent", () => {
    const input = readWsUpgradeCheckInput(makeRequest({ host: "pinchy.example.com" }), "/api/ws");
    expect(input.origin).toBeUndefined();
    expect(input.forwardedProto).toBeUndefined();
  });
});
