import { createHash } from "node:crypto";

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

/**
 * Headers for an access-checked document the browser may keep but must not
 * reuse without asking first.
 *
 * A lifetime (`sessionScopedCacheHeaders`) lets the browser reuse its copy
 * without contacting the server, so a reader whose access was revoked keeps
 * reading the document until the copy expires: the agent's grant was
 * removed, or the reader lost access to the agent, and the cached copy never
 * reaches either check. `no-cache` keeps the copy but makes every reuse a
 * conditional request, which the route answers only after its access check —
 * with 304 and no body when the document is unchanged, so a large PDF is not
 * sent again. `Vary: Cookie` keeps a copy from crossing sessions, as above.
 */
export function sessionScopedRevalidateHeaders(etag: string): {
  "cache-control": string;
  vary: string;
  etag: string;
} {
  return { "cache-control": "private, no-cache", vary: "Cookie", etag };
}

/**
 * A weak validator for one representation of a file on disk.
 *
 * Weak because these fields only make byte-identity likely, not certain (two
 * writes within one timestamp tick, same size). That is enough to answer "has
 * this changed?" with a 304, and it is exactly why a range is never stitched
 * onto a cached copy on the strength of it — see `rangeAllowedByIfRange`.
 *
 * ctime is in it because mtime alone can be carried over: `rsync -a
 * --inplace` or `cp -p` replaces a document with a same-length correction
 * and keeps size, mtime and inode, which would answer 304 for the old
 * edition. No tool can set ctime. `variant` separates two representations of
 * one document (an Office original and its converted PDF).
 */
export function weakFileEtag(
  stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
  variant: string
): string {
  return weakEtag([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino], variant);
}

/**
 * A weak validator for a file in a content-addressed store, which this
 * process touches on every read (the Office artifact store refreshes mtime
 * for its LRU sweep, and that moves ctime too). Timestamps would therefore
 * change on every request and no reuse would ever get a 304. The store path
 * already names the content it holds, so path, size and inode identify it.
 */
export function weakStoredFileEtag(
  stat: { size: number; ino: number },
  storePath: string,
  variant: string
): string {
  const pathKey = createHash("sha256").update(storePath).digest("hex").slice(0, 16);
  return weakEtag([stat.size, stat.ino], `${pathKey}${variant}`);
}

function weakEtag(numbers: number[], tag: string): string {
  const parts = numbers.map((n) => Math.trunc(n).toString(36));
  return `W/"${parts.join("-")}-${tag.replace(/[^a-z0-9]/gi, "")}"`;
}

/**
 * Whether `If-None-Match` names this representation (RFC 9110 §13.1.2): weak
 * comparison, a comma-separated list, or `*` for any current representation.
 * Callers MUST evaluate this only after the access check — a match answers
 * 304, which tells the browser to show what it already holds.
 */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  const ours = opaque(etag);
  return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === ours);
}

/**
 * Whether a `Range` may be honoured given the request's `If-Range`
 * (RFC 9110 §13.1.5). If-Range asks for the range only when the client's copy
 * is the current one, and that needs a STRONG validator match. Every
 * validator served here is weak, so a present If-Range never matches and the
 * range is ignored: the full document is sent instead of splicing a range of
 * a new edition onto a cached copy of the old one.
 */
export function rangeAllowedByIfRange(header: string | null): boolean {
  return header === null;
}
