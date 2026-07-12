/**
 * Guards against open redirects when honoring a `returnTo` destination after
 * login. Only a same-origin, path-relative destination is accepted:
 *
 * - Must start with a single "/" — so it resolves against our own origin.
 * - Must not start with "//" — browsers treat a leading "//host" as
 *   protocol-relative, i.e. a redirect to a different origin.
 * - Must not start with "/\" — some browsers normalize a leading backslash
 *   to a forward slash, turning "/\evil.com" into "//evil.com".
 *
 * Absolute URLs with a scheme (`https://...`), `javascript:` URIs, bare
 * backslash strings (`\\evil.com`), and empty/missing values are all
 * rejected by the leading "must start with /" check. Callers should fall
 * back to a safe default (e.g. "/") when this returns false.
 */
export function isSafeReturnTo(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/\\")) return false;
  return true;
}

/** Fallback destination when no safe `returnTo` is available. */
const DEFAULT_DEST = "/";

/**
 * Builds the `/login?returnTo=...` path the (app) layout redirects to when a
 * request has no session. `dest` is the path+query captured for the current
 * request (see the `x-pathname` header set in `src/proxy.ts`); it falls
 * back to `/` when missing or unsafe.
 */
export function buildLoginRedirectPath(dest: string | null | undefined): string {
  const safeDest = isSafeReturnTo(dest) ? dest : DEFAULT_DEST;
  return `/login?returnTo=${encodeURIComponent(safeDest)}`;
}
