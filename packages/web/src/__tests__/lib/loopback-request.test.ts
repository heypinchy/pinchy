/**
 * Whether the address the operator's browser is actually pointed at is a
 * loopback address.
 *
 * This exists so the "instance is not secured" banner stops firing on a local
 * install, where it is not merely noisy but wrong: browsers treat
 * `http://localhost` as a SECURE CONTEXT — crypto APIs and service workers all
 * work there — precisely because the traffic never leaves the machine. Telling
 * an operator to lock a domain they do not have is advice they cannot act on.
 *
 * THE THING THAT MAKES THESE CASES NON-OBVIOUS: Next.js manufactures the
 * `x-forwarded-*` headers when they are absent, so their presence proves
 * nothing about a proxy. From `next/dist/server/base-server.js`:
 *
 *     req.headers['x-forwarded-host']  ??= req.headers['host'] ?? this.hostname;
 *     req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http';
 *     req.headers['x-forwarded-for']   ??= originalRequest?.socket?.remoteAddress;
 *
 * A first version of this module read any `x-forwarded-*` header as evidence of
 * a proxy and refused to suppress the banner. Under that synthesis the branch
 * was taken on EVERY request, so the feature never once did anything — and the
 * tests were green, because they hand-built a `Headers` object that omitted
 * what Next.js always adds. So every case below carries the synthesized header,
 * exactly as a real request does, and `e2e/21-insecure-banner.spec.ts` proves
 * the same thing against a real Next.js server rather than a fixture.
 *
 * `x-forwarded-for` and `x-forwarded-proto` are consequently not read at all:
 * they are present either way and can discriminate nothing. A check on them
 * would look like a safeguard while deciding nothing, which is worse than no
 * check.
 */
import { describe, it, expect } from "vitest";

import { isLoopbackRequest } from "@/lib/loopback-request";

/**
 * A request as it really arrives with no proxy involved: Next.js has already
 * back-filled `x-forwarded-host` from `Host`.
 */
const direct = (host: string) => isLoopbackRequest({ host, forwardedHost: host });

/** A proxy that passed the client-facing host along in `X-Forwarded-Host`. */
const proxied = (host: string, forwardedHost: string) => isLoopbackRequest({ host, forwardedHost });

describe("isLoopbackRequest", () => {
  it.each([
    "localhost",
    "localhost:7777",
    "127.0.0.1",
    "127.0.0.1:3000",
    // Any 127/8 address is loopback, not just .0.1.
    "127.1.2.3:8080",
    "[::1]",
    "[::1]:7777",
    // RFC 6761 reserves the whole .localhost TLD for loopback.
    "app.localhost",
    "app.localhost:7777",
  ])("recognises a direct request to %s as loopback", (host) => {
    expect(direct(host)).toBe(true);
  });

  it.each([
    "pinchy.example.com",
    "192.168.1.10:7777",
    // Deliberately adjacent to a loopback name without being one.
    "notlocalhost",
    "localhost.evil.com",
    "127.0.0.1.evil.com",
    // A private range is still a network the traffic travels over.
    "10.0.0.5",
  ])("does not treat a direct request to %s as loopback", (host) => {
    expect(direct(host)).toBe(false);
  });

  it("does not treat a missing host as loopback", () => {
    // Absent information is not evidence of safety.
    expect(isLoopbackRequest({ host: null, forwardedHost: null })).toBe(false);
  });

  it("judges the client-facing host when a proxy forwarded a different one", () => {
    // The case worth protecting. Behind a proxy, `Host` describes the hop into
    // the container and says nothing about how the world reaches this instance.
    // `X-Forwarded-Host` does — and differing from `Host` is exactly what marks
    // it as a real value rather than Next.js's back-fill. A public instance
    // must keep its banner.
    expect(proxied("localhost:7777", "pinchy.example.com")).toBe(false);
    expect(proxied("pinchy-web:7777", "pinchy.example.com")).toBe(false);
  });

  it("reads the first entry of a chained X-Forwarded-Host", () => {
    // The chain is oldest-first, so the original client-facing host leads. A
    // second proxy appending its own hop must not flip the verdict.
    expect(
      isLoopbackRequest({ host: "localhost:7777", forwardedHost: "pinchy.example.com, inner:7777" })
    ).toBe(false);
  });

  it("still suppresses when a proxy forwarded a loopback host", () => {
    // Someone put a proxy in front of a local install. Still local.
    expect(proxied("pinchy-web:7777", "localhost:8443")).toBe(true);
  });

  it("falls back to Host when X-Forwarded-Host is absent entirely", () => {
    // Not a shape Next.js produces, but the helper must not depend on Next
    // having run — it is plain input/output and readable from anywhere.
    expect(isLoopbackRequest({ host: "localhost:7777", forwardedHost: null })).toBe(true);
    expect(isLoopbackRequest({ host: "pinchy.example.com", forwardedHost: null })).toBe(false);
  });
});
