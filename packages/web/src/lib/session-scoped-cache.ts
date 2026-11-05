/**
 * Headers for a response the browser may keep for `maxAgeSeconds`.
 *
 * The browser keys its HTTP cache by URL, not by who is signed in. Every
 * cached response in Pinchy sits behind a session, so a bare private max-age
 * serves one user's copy to whoever signs in next on the same browser, and
 * the cached copy never reaches the server's access check (#1286).
 * `Vary: Cookie` makes a different session cookie a cache miss.
 *
 * Use this for every cache lifetime; `browser-cache-session-scope.test.ts`
 * fails on one written by hand.
 */
export function sessionScopedCacheHeaders(maxAgeSeconds: number): {
  "cache-control": string;
  vary: string;
} {
  // Anything else is either invalid on the wire (NaN, a fraction, a negative)
  // or keeps nothing (0, where `no-store` says what is meant), so a caller
  // passing it has made a mistake worth failing on.
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error(
      `cache lifetime must be a positive whole number of seconds, got ${maxAgeSeconds}`
    );
  }
  return {
    "cache-control": `private, max-age=${maxAgeSeconds}`,
    vary: "Cookie",
  };
}
