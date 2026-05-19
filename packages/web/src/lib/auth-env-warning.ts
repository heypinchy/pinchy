/**
 * Two related-but-independent settings interact here:
 *   - `BETTER_AUTH_URL` (env var): the public origin Better Auth writes into
 *     email verification / password reset links.
 *   - Domain Lock (DB setting): the hostname Pinchy itself accepts requests on.
 *
 * Better Auth's own baseURL detection does *not* read our Domain Lock value
 * (verified on staging v0.5.4 — Better Auth still logged
 * "[better-auth] Base URL could not be determined"). So a Domain-Locked
 * deployment without `BETTER_AUTH_URL` will send password-reset emails with
 * broken links. We warn loudly on startup in that case.
 *
 * Pass `domain` from `getCachedDomain()` *after* `bootInits()` has loaded the
 * domain cache, otherwise the Domain-Lock arm of this check is a no-op.
 */
export function getBetterAuthUrlStartupWarning(
  env: NodeJS.ProcessEnv,
  domain: string | null
): string | null {
  if (env.BETTER_AUTH_URL) {
    return (
      "⚠ BETTER_AUTH_URL is set. Request-host trust is now configured via Domain Lock " +
      "(Settings → Security). BETTER_AUTH_URL only controls outbound URLs Better Auth " +
      "writes into email verification and password reset links — make sure it matches " +
      "the hostname your users actually open Pinchy at."
    );
  }

  if (domain && domain.length > 0) {
    return (
      `⚠ Domain Lock is configured (${domain}) but BETTER_AUTH_URL is unset. ` +
      "Outbound links in email verification and password reset emails will be wrong. " +
      `Set BETTER_AUTH_URL=https://${domain} in your environment and restart Pinchy.`
    );
  }

  return null;
}
