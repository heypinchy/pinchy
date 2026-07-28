/**
 * Is the address the operator's browser is actually pointed at a loopback
 * address? Used to decide whether the "instance is not secured" banner has
 * anything useful to say.
 *
 * On a local install it does not: browsers already treat `http://localhost` as
 * a secure context — the traffic never leaves the machine — so telling an
 * operator to lock a domain they do not have is advice they cannot act on.
 *
 * This is a DISPLAY decision only. The security behaviour that matters, whether
 * auth cookies are issued `Secure`/`__Secure-`, is decided separately in
 * `secure-cookies.ts` from the persisted domain-lock flag, and nothing here
 * touches it.
 */

export interface RequestOrigin {
  /** The `Host` header: which hop the request arrived on. */
  host: string | null;
  /** `X-Forwarded-Host`, if a proxy set one. See `externalHost` for the catch. */
  forwardedHost: string | null;
}

/**
 * A host that resolves to this machine and nowhere else: `localhost`, the whole
 * 127/8 range, IPv6 `::1`, and the RFC 6761-reserved `.localhost` TLD.
 *
 * Anchored on a full label boundary so `localhost.evil.com` and
 * `127.0.0.1.evil.com` — both perfectly registrable — do not slip through on a
 * prefix match.
 */
function isLoopbackHost(host: string): boolean {
  // Strip the port. IPv6 literals arrive bracketed (`[::1]:7777`), so take the
  // bracketed part first and only then look for a trailing `:port`.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  const hostname = (bracketed ? bracketed[1] : host.replace(/:\d+$/, "")).toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 — every address in it is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The host the world uses to reach this instance, as best we can know it.
 *
 * The catch that shapes this whole function: **Next.js manufactures the
 * `x-forwarded-*` headers when they are missing**, so their presence is not
 * evidence of a proxy (`next/dist/server/base-server.js`):
 *
 *     req.headers['x-forwarded-host'] ??= req.headers['host'] ?? this.hostname;
 *
 * What that back-fill leaves usable is the COMPARISON. A synthesized
 * `X-Forwarded-Host` equals `Host` by construction; a value that differs can
 * only have come from a real proxy, and then it — not `Host`, which describes
 * the internal hop — is the client-facing name.
 *
 * Known limitation, deliberately accepted: a proxy that rewrites `Host` to
 * `localhost` and sets no `X-Forwarded-Host` (nginx `proxy_pass` without
 * `proxy_set_header`) is indistinguishable from a genuinely local request, and
 * a public instance configured that way loses the banner. No header can tell
 * those apart, because that configuration destroys the only evidence. It is
 * also not a silent state: such a proxy breaks Better Auth's trusted origins
 * and every absolute redirect, so the install announces itself in louder ways
 * than a missing banner.
 */
function externalHost({ host, forwardedHost }: RequestOrigin): string | null {
  if (forwardedHost && forwardedHost !== host) {
    // Oldest-first by convention, so the original client-facing host leads.
    const first = forwardedHost.split(",")[0]!.trim();
    if (first) return first;
  }
  return host;
}

export function isLoopbackRequest(origin: RequestOrigin): boolean {
  const external = externalHost(origin);
  return external !== null && isLoopbackHost(external);
}
