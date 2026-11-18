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
  // Strip the port. IPv6 literals belong in brackets (`[::1]:7777`), so take
  // the bracketed part first and only then look for a trailing `:port`.
  //
  // Unbracketed IPv6 has to survive too: `Host` is bracketed per RFC 7230, but
  // `X-Forwarded-Host` is written by proxies and plenty of them emit the bare
  // address. A naive `:port` strip turns `::1` into `:` and
  // `0:0:0:0:0:0:0:1` into `0:0:0:0:0:0:0`, which silently made both loopback
  // checks below unreachable for exactly those inputs. So only strip when what
  // is left cannot be an IPv6 address — a single colon. An unbracketed IPv6
  // address WITH a port (`::1:7777`) stays ambiguous by construction and is not
  // handled; nothing legitimate produces it.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  const unbracketed = (host.match(/:/g)?.length ?? 0) > 1 ? host : host.replace(/:\d+$/, "");
  // A trailing dot is the fully-qualified spelling of the same name — browsers
  // pass it through to `Host` verbatim — and it must not be able to dodge the
  // label-boundary anchoring below.
  const hostname = (bracketed ? bracketed[1] : unbracketed).toLowerCase().replace(/\.$/, "");

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
 * The hard case for the comparison alone: a proxy that rewrites `Host` to
 * `localhost` and sets no `X-Forwarded-Host` (nginx `proxy_pass` without
 * `proxy_set_header`) leaves a public instance indistinguishable from a local
 * one by every host-shaped measure. No HOST header can tell those apart — that
 * configuration destroys the evidence. The scheme still can, which is why the
 * caller in `insecure-banner.tsx` also consults `x-forwarded-proto`; see the
 * note there. What remains uncovered is such a proxy that terminates plain HTTP
 * as well, i.e. an instance that is unencrypted end to end AND lies about its
 * host — and that one is not a silent state either: it breaks Better Auth's
 * trusted origins (`auth.ts` derives them from these same headers) and every
 * absolute redirect, so it announces itself far louder than by a missing
 * banner.
 *
 * Note also that `X-Forwarded-Host` is only as trustworthy as whatever sits in
 * front: with no proxy stripping it, a client can send it and thereby move this
 * verdict. That is tolerable here and nowhere else — the header steers a banner
 * the sender sees themselves, so the only thing anyone can do with it is hide
 * their own warning. Do NOT reuse this helper for a decision with a blast
 * radius beyond the requester.
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
