import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CLIENT_IP_HEADER,
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  readForwardedFor,
  resolveClientIp,
  stampClientIp,
} from "@/server/client-ip";

const LOOPBACK_ONLY = DEFAULT_TRUSTED_PROXIES;

// The whole module rests on running better-auth's OWN resolver, so that the
// address an audit row names is the address the sign-in throttle bucketed by.
// That holds only while there is one copy of it: better-auth pins
// `@better-auth/core` to an exact version, we declare it with a caret, and a
// dependency bump can therefore resolve a second copy — two implementations,
// silently, with nothing else in the suite able to notice.
describe("the shared better-auth resolver", () => {
  function version(pkg: string): string {
    const url = new URL(`../../../node_modules/${pkg}/package.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf8")).version as string;
  }

  function pinnedByBetterAuth(): string {
    const url = new URL("../../../node_modules/better-auth/package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["@better-auth/core"] ?? "";
  }

  it("is the same @better-auth/core instance better-auth itself uses", () => {
    expect(
      version("@better-auth/core"),
      "packages/web resolves a different @better-auth/core than better-auth depends on, so " +
        "getIPFromHeader here and the sign-in throttle's own copy can disagree about who a " +
        "request is. Align the specifier in packages/web/package.json."
    ).toBe(pinnedByBetterAuth());
  });
});

describe("parseTrustedProxies", () => {
  it("falls back to loopback when the operator configured nothing", () => {
    expect(parseTrustedProxies(undefined)).toEqual({
      trusted: DEFAULT_TRUSTED_PROXIES,
      invalid: [],
    });
    expect(parseTrustedProxies("   ")).toEqual({
      trusted: DEFAULT_TRUSTED_PROXIES,
      invalid: [],
    });
  });

  it("reads a comma-separated list of addresses and CIDR ranges", () => {
    expect(parseTrustedProxies("10.0.0.0/8, 172.18.0.1 ,2400:cb00::/32")).toEqual({
      trusted: ["10.0.0.0/8", "172.18.0.1", "2400:cb00::/32"],
      invalid: [],
    });
  });

  // A typo'd entry must not read as "configured": the operator who wrote
  // `10.0.0.0/8x` believes their inner proxy is trusted, and better-auth
  // silently drops it. Reporting it separately is what lets server.ts say so
  // at startup instead of leaving a half-applied trust list.
  it("separates entries that are neither an IP nor a CIDR range", () => {
    expect(parseTrustedProxies("10.0.0.0/8, nginx, 999.1.1.1")).toEqual({
      trusted: ["10.0.0.0/8"],
      invalid: ["nginx", "999.1.1.1"],
    });
  });

  // An all-invalid list must not silently degrade to "trust nothing", which
  // would flip the resolver back onto the single-value rule this whole module
  // exists to get rid of.
  it("keeps the loopback default when every configured entry is invalid", () => {
    expect(parseTrustedProxies("nginx")).toEqual({
      trusted: DEFAULT_TRUSTED_PROXIES,
      invalid: ["nginx"],
    });
  });
});

describe("readForwardedFor", () => {
  it("reads the header as sent", () => {
    expect(readForwardedFor({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
  });

  // Node joins repeated headers for us, but a proxy that emits the header
  // twice must not lose a hop: dropping the second occurrence would delete
  // the very entry the right-to-left walk is supposed to land on.
  it("joins a repeated header rather than taking the first occurrence", () => {
    expect(readForwardedFor({ "x-forwarded-for": ["1.2.3.4", "203.0.113.9"] })).toBe(
      "1.2.3.4, 203.0.113.9"
    );
  });

  it("returns undefined when no proxy set the header", () => {
    expect(readForwardedFor({})).toBeUndefined();
  });
});

describe("resolveClientIp", () => {
  it("uses the socket peer when no proxy forwarded anything", () => {
    expect(
      resolveClientIp({
        forwardedFor: undefined,
        socketAddress: "203.0.113.9",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "203.0.113.9", source: "socket" });
  });

  it("normalizes an IPv4-mapped socket address", () => {
    expect(
      resolveClientIp({
        forwardedFor: undefined,
        socketAddress: "::ffff:172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "172.18.0.1", source: "socket" });
  });

  // better-auth collapses an IPv6 address to its /64 before keying on it, and
  // we inherit that on both paths. Correct for a limiter — a single client
  // routinely owns every address in its /64, so keying per address would make
  // the limit meaningless — and lossy for an audit row, which is why
  // `concepts/audit-trail` says so out loud rather than presenting a network
  // as the visitor's address. Pinned here so a dependency bump that changes
  // the granularity shows up as a failing test and not as an audit trail that
  // quietly started meaning something else.
  it("records an IPv6 client as its /64 network, on both paths", () => {
    expect(
      resolveClientIp({
        forwardedFor: "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
        socketAddress: "172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "2001:0db8:0001:0002:0000:0000:0000:0000", source: "forwarded" });

    expect(
      resolveClientIp({
        forwardedFor: undefined,
        socketAddress: "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "2001:0db8:0001:0002:0000:0000:0000:0000", source: "socket" });
  });

  it("takes the forwarded address ahead of the proxy's own peer address", () => {
    expect(
      resolveClientIp({
        forwardedFor: "203.0.113.9",
        socketAddress: "172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "203.0.113.9", source: "forwarded" });
  });

  // The bypass in #825. An attacker prepends their own X-Forwarded-For, the
  // proxy appends the address it actually saw, and the rightmost untrusted hop
  // is the only one the attacker cannot choose. Before this module the header
  // had two values, which better-auth refuses to read at all — every sign-in
  // then shared one bucket.
  it("ignores an attacker-supplied hop to the left of the proxy's own", () => {
    expect(
      resolveClientIp({
        forwardedFor: "1.2.3.4, 203.0.113.9",
        socketAddress: "172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "203.0.113.9", source: "forwarded" });
  });

  // Why the default trust list is loopback and NOT the RFC1918 ranges: on a
  // company LAN the real client IS a private address, and trusting 192.168/16
  // would strip it and hand the attacker's forged hop back instead — the same
  // bypass, reintroduced by a default that looks more thorough.
  it("does not strip a private client address under the default trust list", () => {
    expect(
      resolveClientIp({
        forwardedFor: "1.2.3.4, 192.168.1.50",
        socketAddress: "172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "192.168.1.50", source: "forwarded" });
  });

  it("walks past every configured proxy hop in a multi-proxy chain", () => {
    expect(
      resolveClientIp({
        forwardedFor: "203.0.113.9, 10.0.0.5, 10.0.0.6",
        socketAddress: "10.0.0.6",
        trustedProxies: ["10.0.0.0/8"],
      })
    ).toEqual({ address: "203.0.113.9", source: "forwarded" });
  });

  it("falls back to the peer when every forwarded hop is a trusted proxy", () => {
    expect(
      resolveClientIp({
        forwardedFor: "127.0.0.1",
        socketAddress: "127.0.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "127.0.0.1", source: "socket" });
  });

  it("falls back to the peer when the header is not an address at all", () => {
    expect(
      resolveClientIp({
        forwardedFor: "unknown",
        socketAddress: "172.18.0.1",
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: "172.18.0.1", source: "socket" });
  });

  it("reports no address rather than an invented one", () => {
    expect(
      resolveClientIp({
        forwardedFor: undefined,
        socketAddress: undefined,
        trustedProxies: LOOPBACK_ONLY,
      })
    ).toEqual({ address: null, source: "unknown" });
  });
});

describe("stampClientIp", () => {
  it("writes the resolved address into the internal header", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-forwarded-for": "203.0.113.9",
    };
    const resolved = stampClientIp(headers, {
      trustedProxies: LOOPBACK_ONLY,
      socketAddress: "127.0.0.1",
    });

    expect(resolved).toEqual({ address: "203.0.113.9", source: "forwarded" });
    expect(headers[CLIENT_IP_HEADER]).toBe("203.0.113.9");
  });

  // The header is trusted blindly by better-auth once it is in
  // `ipAddressHeaders`, so an inbound copy is a complete throttle bypass. It
  // has to be overwritten on every request, including the ones where we cannot
  // resolve anything and therefore write nothing.
  it("discards a client-supplied copy of the internal header", () => {
    const headers: Record<string, string | string[] | undefined> = {
      [CLIENT_IP_HEADER]: "9.9.9.9",
      "x-forwarded-for": "203.0.113.9",
    };
    stampClientIp(headers, { trustedProxies: LOOPBACK_ONLY, socketAddress: "127.0.0.1" });

    expect(headers[CLIENT_IP_HEADER]).toBe("203.0.113.9");
  });

  it("leaves no header behind when no address can be resolved", () => {
    const headers: Record<string, string | string[] | undefined> = {
      [CLIENT_IP_HEADER]: "9.9.9.9",
    };
    const resolved = stampClientIp(headers, {
      trustedProxies: LOOPBACK_ONLY,
      socketAddress: undefined,
    });

    expect(resolved.address).toBeNull();
    expect(headers[CLIENT_IP_HEADER]).toBeUndefined();
  });
});
