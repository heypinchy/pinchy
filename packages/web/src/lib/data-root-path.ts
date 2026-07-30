/**
 * The data root, and the one definition of what it contains.
 *
 * No imports on purpose. `pluginConfigSchema` (domain-validation.ts) enforces
 * the boundary below, and a client component transitively imports that schema
 * — so the rule must not drag `node:path` into the browser bundle.
 * `path-validation.ts` imports DATA_ROOT from HERE rather than the other way
 * round, for exactly that reason.
 *
 * NOTE for anyone reconciling this branch with `main`: on `main` this lives in
 * `knowledge/citation-path.ts`, which already existed as an import-free module
 * holding DATA_ROOT (the #933 citation-path work). That refactor is not on
 * this release branch, so the backport gives the predicate its own module
 * instead of pulling #933 along with a security fix. Same rule, same tests,
 * different file.
 */

/** The one mount every corpus and every agent-visible file lives under. */
export const DATA_ROOT = "/data/";

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
