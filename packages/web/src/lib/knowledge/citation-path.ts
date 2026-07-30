/**
 * The two directions between the path ingest stored and the path a citation
 * shows.
 *
 * A citation earns trust only if the reader can (a) find the document and (b)
 * check the spot. We store what the CONTAINER sees — `/data/noack/OLD/QF_2012/
 * PrintingFiles_QF/x.pdf` — and nobody at the customer has ever seen that
 * prefix; what they know from Explorer is the tree below the mount. So a
 * citation shows the path relative to the data root. (#933)
 *
 * The pair is a bijection, and that is a requirement rather than tidiness. The
 * citation string is not only read by a human: `source-links.ts` linkifies it,
 * and the link has to resolve back to the exact file retrieval returned. Which
 * is also why the MOUNT segment stays. Dropping it too would read marginally
 * closer to Explorer and cost two things worth more — `hr/policy.pdf` and
 * `eng/policy.pdf` would collapse into one indistinguishable citation, the
 * failure a full path exists to prevent, and there would be no way back to an
 * absolute path at all, so every citation link would break.
 *
 * `sourcePath` stays absolute everywhere it IDENTIFIES a document — the
 * retrieval audit row, the plugin's `returnedDocumentIds`, the workspace-file
 * route — because those need the path the filesystem answers to.
 *
 * No imports on purpose: this module is reached from a client component (the
 * markdown renderer, via source-links.ts), so it must not drag `node:path` into
 * the browser bundle. `path-validation.ts` imports DATA_ROOT from HERE for the
 * same reason, rather than the other way round.
 */

/** The one mount every corpus and every agent-visible file lives under. */
export const DATA_ROOT = "/data/";

/**
 * Absolute stored path → the path a citation shows.
 *
 * A path outside the data root cannot come from ingest (path-validation.ts
 * confines it) and is returned unchanged rather than guessed at.
 */
export function toCitationPath(absolutePath: string): string {
  return absolutePath.startsWith(DATA_ROOT) ? absolutePath.slice(DATA_ROOT.length) : absolutePath;
}

/**
 * The path a citation shows → the absolute path to open.
 *
 * The input is MODEL output, so it is untrusted: leading slashes and `..`
 * segments are stripped before prefixing, which makes the result unconditionally
 * a path under the data root. That is the outer of two gates — the
 * workspace-file route still resolves the result and re-checks it against the
 * agent's granted `allowed_paths` — but it means a fabricated citation cannot
 * even be SHAPED into an escape before it gets there.
 */
export function fromCitationPath(citationPath: string): string {
  const confined = citationPath
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
  return DATA_ROOT + confined;
}

/**
 * Collapse `.`/`..`/empty segments in an ABSOLUTE POSIX path, as a pure string
 * operation.
 *
 * `node:path`'s `resolve()` would do this, but it cannot live in this module
 * (see the header) and the rule below is needed on both sides of the bundle
 * boundary. `..` above the root is clamped at the root, matching `resolve()`.
 */
function normalizeAbsolute(absolutePath: string): string {
  const segments: string[] = [];
  for (const segment of absolutePath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return "/" + segments.join("/");
}

/**
 * Is `candidate` a directory the data root actually contains?
 *
 * This is the single definition of the boundary that confines an agent's
 * `pinchy-files.allowed_paths` — the allowlist that scopes its file tools, its
 * knowledge-base retrieval filter and the browser-facing workspace-file route
 * all at once. It is enforced in `pluginConfigSchema`, so every writer of that
 * column shares it; `sanitizePath` is the throwing form of the same rule.
 *
 * Deliberately stricter than `resolve()` in one respect: a RELATIVE path is
 * rejected outright rather than resolved against the server's working
 * directory. A stored allowlist entry whose meaning depends on where the
 * process happens to have been started is not a grant anyone can reason about.
 */
export function isPathUnderDataRoot(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  // A null byte can truncate the path inside a native call, so what the
  // check sees and what the syscall opens would differ.
  if (candidate.includes("\0")) return false;
  if (!candidate.startsWith("/")) return false;
  // Trailing separator on both sides: `/database` must not pass as `/data`.
  return (normalizeAbsolute(candidate) + "/").startsWith(DATA_ROOT);
}
