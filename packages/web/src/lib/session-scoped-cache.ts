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
  return {
    "cache-control": `private, max-age=${maxAgeSeconds}`,
    vary: "Cookie",
  };
}
