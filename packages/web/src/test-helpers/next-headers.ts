/**
 * Resolve what a CONCRETE URL actually receives from `next.config.ts`'s
 * `headers()` — as opposed to what a route handler asks for, or what appears
 * somewhere in the config.
 *
 * That distinction is the whole reason this module exists. A config-level
 * header OVERRIDES whatever a route handler sets in its own response, so a
 * route test asserting the handler's header can be green while every real
 * response carries the opposite value. Two file-serving routes shipped broken
 * exactly that way (#703 / #788 artifacts, and the KB citation viewer): a valid
 * `200 application/pdf` that the browser refused to embed with
 * `net::ERR_BLOCKED_BY_RESPONSE`, i.e. a blank viewer pane.
 *
 * Test-only. This models the subset of Next.js source syntax the config
 * actually uses; `resolveHeader` throws rather than guessing when it meets
 * anything outside that subset.
 */
import nextConfig from "../../next.config";

/**
 * Escapes EVERY regex metacharacter, backslash included. Completeness is the
 * point: a partial escape is both a correctness bug and a CodeQL
 * `js/incomplete-sanitization` finding.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts a next.config `source` pattern to a matcher.
 *
 * Supported syntax: `:param` (exactly one path segment) and the `(.*)`
 * catch-all. Everything else is a LITERAL — which is why the escape runs
 * first: without it the dot in `/sw.js` would act as a wildcard and match
 * `/swXjs`, silently applying a rule to a path it never covered.
 */
export function matchesSource(source: string, path: string): boolean {
  const pattern = escapeRegex(source)
    // `(.*)` survives the escape as `\(\.\*\)` — restore it as a wildcard.
    .replace(/\\\(\\\.\\\*\\\)/g, ".*")
    // `:param` has no metacharacters, so it reaches here untouched.
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+");
  // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is built from a fully-escaped literal plus two fixed expansions
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * The value `path` ends up with for `key`.
 *
 * Later entries override earlier ones for the same key — which is exactly why
 * the relaxing rules are written AFTER the catch-all in next.config.ts. Get
 * that order wrong and the catch-all wins silently.
 */
export async function resolveHeader(path: string, key: string): Promise<string | undefined> {
  const entries = await nextConfig.headers!();
  let value: string | undefined;
  for (const entry of entries) {
    if (!matchesSource(entry.source, path)) continue;
    // `has`/`missing` make a rule conditional on the request (cookies, headers,
    // query). Nothing here uses them, and silently ignoring them would make
    // this resolver claim a value the request may not actually get — the exact
    // class of false-green this module exists to prevent.
    if ("has" in entry || "missing" in entry) {
      throw new Error(
        `next.config source ${entry.source} uses has/missing, which resolveHeader does not model. ` +
          `Teach it the conditional, or assert against a real server instead.`
      );
    }
    for (const header of entry.headers) {
      if (header.key.toLowerCase() === key.toLowerCase()) value = header.value;
    }
  }
  return value;
}

/**
 * Maps an App Router `route.ts` file path to the `source` pattern that
 * next.config must use to target it, and to a concrete URL for `resolveHeader`.
 *
 * `src/app/api/agents/[agentId]/artifacts/[filename]/route.ts`
 *   → source `/api/agents/:agentId/artifacts/:filename`
 *   → path   `/api/agents/sample/artifacts/sample`
 */
export function routeFileToSource(routeFileRelativeToApp: string): {
  source: string;
  samplePath: string;
} {
  const segments = routeFileRelativeToApp
    .replace(/\\/g, "/")
    .replace(/\/route\.tsx?$/, "")
    .split("/")
    .filter(Boolean);

  const sourceSegments: string[] = [];
  const pathSegments: string[] = [];
  for (const segment of segments) {
    const dynamic = /^\[(.+)]$/.exec(segment);
    if (!dynamic) {
      sourceSegments.push(segment);
      pathSegments.push(segment);
      continue;
    }
    const name = dynamic[1];
    if (name.startsWith("...")) {
      // A catch-all spans an unknown number of segments, so a single sample
      // path cannot stand in for it. No serving route uses one today.
      throw new Error(
        `Catch-all segment [${name}] in ${routeFileRelativeToApp} is not modelled by routeFileToSource.`
      );
    }
    sourceSegments.push(`:${name}`);
    pathSegments.push("sample");
  }

  return {
    source: `/${sourceSegments.join("/")}`,
    samplePath: `/${pathSegments.join("/")}`,
  };
}
