import { getDomain } from "@/lib/domain";
import { publicHopOf, readRequestHostFromHeaders } from "@/server/forwarded-host";
import { normalizeLockableHost } from "@/lib/domain-validation";

/**
 * The origin every invite and reset link points at — the one an admin copies
 * from the dialog and the one an email carries. Both come from here, so the
 * two can never disagree.
 *
 * Built on the server rather than from `window.location.origin`: the host the
 * admin happens to browse is not necessarily one the recipient can reach. An
 * admin working inside Citrix reaches Pinchy through an internal hostname, and
 * a link built from that host opens nowhere for the person it is sent to.
 *
 * 1. The locked domain (Settings → Security), when set. It is the one origin
 *    an admin configured on purpose, and it makes the link independent of a
 *    caller-supplied `X-Forwarded-Host`. Domain lock requires HTTPS.
 *
 *    Read from the database, NOT `getCachedDomain()`: route bundles load
 *    `src/lib` as a second module instance (see lib/process-wide-cache.ts),
 *    and that instance's domain cache is never filled at boot — it would
 *    report "no lock" on every locked install.
 * 2. Otherwise the host the admin is browsing — the public hop of
 *    `X-Forwarded-Host`, read the same way the request gates read it, so a
 *    CDN in front of Caddy doesn't produce `https://a.example, caddy:443`.
 * 3. A forwarded value that isn't a plausible host falls back to the URL the
 *    request arrived on rather than building a link nobody can open.
 */
export async function resolveLinkOrigin(request: Request): Promise<string> {
  const domain = await getDomain();
  if (domain) return `https://${domain}`;

  const fallback = new URL(request.url).origin;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = readRequestHostFromHeaders(request.headers);
  if (!forwardedProto || !host) return fallback;

  const proto = publicHopOf(forwardedProto).toLowerCase();
  if (proto !== "https" && proto !== "http") return fallback;
  const safeHost = normalizeLockableHost(host);
  if (!safeHost) return fallback;
  return `${proto}://${safeHost}`;
}
