import { getCachedDomain } from "@/lib/domain-cache";
import { resolveForwardedOrigin } from "@/lib/integrations/oauth-request";

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
 * 2. Otherwise the host the admin is browsing, read the same way the OAuth
 *    routes read it — which is what the copy-link path shows them too.
 */
export function resolveLinkOrigin(request: Request): string {
  const domain = getCachedDomain();
  if (domain) return `https://${domain}`;
  return resolveForwardedOrigin(request).origin;
}
