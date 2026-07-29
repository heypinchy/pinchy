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
