/**
 * Guards against open redirects when honoring a `returnTo` destination after
 * login. Only a same-origin, path-relative destination is accepted. Callers
 * should fall back to a safe default (e.g. "/") when this returns false.
 *
 * A prefix-only check is NOT enough: WHATWG URL parsing (and browsers)
 * strip ASCII tab/CR/LF from anywhere in the string, which can merge a
 * later "/" into the leading position. For example `"/\t/evil.com"` parses
 * to `//evil.com`, i.e. the protocol-relative `https://evil.com/` — a
 * classic post-login phishing redirect. Next's client router turns
 * `router.push("/\t/evil.com")` into a hard navigation to that origin.
 *
 * So we reject the obvious protocol-relative / backslash tricks up front,
 * then resolve the value against a sentinel origin and require that:
 *
 * - the resolved origin is unchanged (control-char stripping, encoded
 *   tricks, etc. that escape our origin are rejected), and
 * - the decoded pathname does not itself start with "//" or "/\", which
 *   would be a protocol-relative redirect smuggled through as `%2F%2F`.
 *
 * Absolute URLs with a scheme (`https://...`), `javascript:` URIs, bare
 * backslash strings (`\\evil.com`), and empty/missing values never make it
 * past the leading checks or the origin comparison.
 */
export function isSafeReturnTo(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return false;
  }
  try {
    const base = "http://internal.invalid";
    const url = new URL(value, base);
    if (url.origin !== base || !url.pathname.startsWith("/")) return false;
    // Reject encoded slash tricks: a decoded path that starts with "//" or
    // "/\" is a protocol-relative redirect in disguise (e.g. "/%2F%2Fevil.com").
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith("//") || decodedPath.startsWith("/\\")) return false;
    return true;
  } catch {
    return false;
  }
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
