import type { IncomingMessage } from "http";

/**
 * How both request gates in `server.ts` decide which host a request claims.
 *
 * It lives in one module because the two gates read the same header to answer
 * two halves of one question — the domain lock asks whether the request was
 * addressed to us, the CSRF gate whether it came from us — and they must not
 * disagree about what the header says. They did: the CSRF gate folded a
 * multi-hop value to its public hop while the domain lock compared the whole
 * string, so a deployment with two proxies passed one gate and was answered
 * 403 by the other.
 */

/** A repeated header arrives as an array; only the first value is the claim. */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * RFC 7239 multi-hop: `x-forwarded-host` may be "public.example.com, internal:7777"
 * once more than one proxy has appended to it. The first hop is the name the
 * browser actually addressed — the one the domain lock is configured with and
 * the one `Origin` is compared against.
 */
export function publicHopOf(host: string): string {
  const comma = host.indexOf(",");
  return (comma === -1 ? host : host.slice(0, comma)).trim();
}

/**
 * The host a request claims: the proxy's `x-forwarded-host` when present,
 * otherwise `Host`, reduced to its public hop.
 *
 * An empty forwarded header falls back to `Host` rather than blanking the
 * result — it asserts nothing, and treating it as an assertion would fail a
 * request `Host` can answer perfectly well.
 */
export function readRequestHost(headers: IncomingMessage["headers"]): string | undefined {
  return resolveRequestHost(
    firstHeaderValue(headers["x-forwarded-host"]),
    firstHeaderValue(headers.host)
  );
}

/**
 * The same reading for a fetch-API `Headers` object — route handlers get one
 * of those rather than Node's header bag.
 *
 * `POST /api/settings/domain` needs it as much as the gates do: it stores
 * whatever host the request arrived on as the locked domain, and a stored
 * proxy chain is a domain no browser can ever send. That is a lockout, and
 * avoiding one is the entire safety guarantee the domain lock advertises.
 */
export function readRequestHostFromHeaders(headers: Headers): string | undefined {
  return resolveRequestHost(
    headers.get("x-forwarded-host") ?? undefined,
    headers.get("host") ?? undefined
  );
}

function resolveRequestHost(
  forwarded: string | undefined,
  host: string | undefined
): string | undefined {
  const raw = (forwarded && forwarded.trim()) || host;
  if (!raw) return undefined;
  return publicHopOf(raw) || undefined;
}
