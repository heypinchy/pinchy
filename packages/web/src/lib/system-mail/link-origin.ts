import { getDomain } from "@/lib/domain";
import { publicHopOf, readRequestHostFromHeaders } from "@/server/forwarded-host";
import { normalizeLockableHost } from "@/lib/domain-validation";

/**
 * The origin a link in an email points at.
 *
 * The copy-link path builds its link in the browser from
 * `window.location.origin` (lib/invite-url.ts). An email is built on the
 * server, so it needs the same answer there:
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
