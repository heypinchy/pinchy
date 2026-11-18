// Both request gates in server.ts decide on the same header, and until #599's
// follow-up they read it differently: the CSRF gate folded an RFC 7239
// multi-hop value ("public.example.com, internal:7777") to its public hop,
// while the domain-lock gate compared the whole string against the locked
// domain and rejected it. Behind two proxies — a CDN in front of Caddy is the
// ordinary shape — that turned away legitimate traffic with the same 403 the
// original bug produced, one layer further in.
//
// So the reading lives in one module, and the last test here is the invariant
// that matters: what one gate accepts, the other must not block.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "http";

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return { ...actual, getCachedDomain: vi.fn() };
});

import { readRequestHost, publicHopOf, firstHeaderValue } from "@/server/forwarded-host";
import { isHostAllowed } from "@/server/host-check";
import { isCsrfRequestAllowed } from "@/server/csrf-check";
import { getCachedDomain } from "@/lib/domain-cache";

function headersOf(headers: Record<string, string | string[]>): IncomingMessage["headers"] {
  return headers as IncomingMessage["headers"];
}

describe("firstHeaderValue", () => {
  it("unwraps a repeated header to its first value", () => {
    expect(firstHeaderValue(["a.example.com", "b.example.com"])).toBe("a.example.com");
  });

  it("passes a plain value and undefined through", () => {
    expect(firstHeaderValue("a.example.com")).toBe("a.example.com");
    expect(firstHeaderValue(undefined)).toBeUndefined();
  });
});

describe("publicHopOf", () => {
  it("takes the first hop of a comma-separated chain", () => {
    // The browser addressed the first name; every later hop is a proxy's own
    // view of the request and never the domain the lock is configured with.
    expect(publicHopOf("public.example.com, internal:7777")).toBe("public.example.com");
  });

  it("leaves a single host untouched", () => {
    expect(publicHopOf("public.example.com")).toBe("public.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(publicHopOf("  public.example.com  , internal:7777")).toBe("public.example.com");
  });
});

describe("readRequestHost", () => {
  it("prefers x-forwarded-host over host", () => {
    expect(
      readRequestHost(
        headersOf({ host: "internal:7777", "x-forwarded-host": "pinchy.example.com" })
      )
    ).toBe("pinchy.example.com");
  });

  it("folds a multi-hop x-forwarded-host to its public hop", () => {
    expect(
      readRequestHost(
        headersOf({
          host: "internal:7777",
          "x-forwarded-host": "pinchy.example.com, internal:7777",
        })
      )
    ).toBe("pinchy.example.com");
  });

  it("unwraps a repeated x-forwarded-host header", () => {
    expect(
      readRequestHost(
        headersOf({
          host: "internal:7777",
          "x-forwarded-host": ["pinchy.example.com", "evil.test"],
        })
      )
    ).toBe("pinchy.example.com");
  });

  it("falls back to host when there is no proxy header", () => {
    expect(readRequestHost(headersOf({ host: "pinchy.example.com" }))).toBe("pinchy.example.com");
  });

  it("falls back to host when the proxy header is present but empty", () => {
    // An empty forwarded header is not a claim about anything; treating it as
    // one would blank the host and fail a request the Host header can answer.
    expect(readRequestHost(headersOf({ host: "pinchy.example.com", "x-forwarded-host": "" }))).toBe(
      "pinchy.example.com"
    );
  });

  it("returns undefined when neither header is present", () => {
    expect(readRequestHost(headersOf({}))).toBeUndefined();
  });
});

describe("the two request gates agree on the host", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
  });

  // The cross-gate invariant, not either gate in isolation: a deployment that
  // satisfies the CSRF gate must not be turned away by the domain lock over
  // the very same header value.
  it("accepts a two-proxy chain in both gates", () => {
    const forwarded = "pinchy.example.com, internal:7777";
    const host = readRequestHost(
      headersOf({ host: "internal:7777", "x-forwarded-host": forwarded })
    );

    expect(isHostAllowed(host, "/api/agents")).toBe(true);
    expect(
      isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "https://pinchy.example.com",
        referer: undefined,
        host,
        forwardedProto: "https",
      })
    ).toEqual({ allowed: true });
  });

  it("still rejects a foreign host in both gates", () => {
    const host = readRequestHost(headersOf({ host: "evil.example.com" }));

    expect(isHostAllowed(host, "/api/agents")).toBe(false);
    expect(
      isCsrfRequestAllowed({
        method: "POST",
        pathname: "/api/agents",
        origin: "https://pinchy.example.com",
        referer: undefined,
        host,
        forwardedProto: "https",
      })
    ).toEqual({ allowed: false, reason: "origin-mismatch" });
  });
});
