import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sessionScopedCacheHeaders } from "@/lib/session-scoped-cache";

/**
 * Tripwire: a response the browser may keep must be keyed to the session.
 *
 * The browser keys its HTTP cache by URL, not by who is signed in. Every
 * cached response here is behind a session, so a bare `private, max-age=N`
 * hands one user's copy to whoever signs in next on the same browser for the
 * whole max-age — and the cached copy never reaches the access check that
 * would have refused them. #1286 found it on the agent list (5 s of another
 * user's agent names); the same header sat on workspace files for an hour.
 *
 * `sessionScopedCacheHeaders` pairs the max-age with `Vary: Cookie`, so a
 * different session cookie is a cache miss and the request reaches the
 * server again. This guard fails on any cache lifetime written by hand
 * anywhere else in production source, so the pairing cannot be forgotten.
 * It reads lines, comments included, so a comment naming a lifetime trips it
 * too: describe it in prose ("a short private cache") instead.
 *
 * A lifetime is itself the exception. Within one session it still lets the
 * browser reuse its copy without asking, past a revoked grant, so access-
 * checked content uses `sessionScopedRevalidateHeaders` (no-cache + ETag)
 * and only the routes in MAY_SET_A_LIFETIME below may use the helper above.
 */

const webSrcDir = path.resolve(__dirname, "../..");
const HELPER = path.join(webSrcDir, "lib", "session-scoped-cache.ts");
const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules", "test-helpers"]);
// Any non-zero max-age, s-maxage or stale-* extension, in any position and
// whether written out or templated (`max-age=${n}`), plus an `expires` header,
// whether written as a quoted or bare object key or passed to
// `headers.set("Expires", …)`, and a Last-Modified, which grants a heuristic
// lifetime. max-age=0 keeps nothing, so it is not a
// lifetime.
const CACHE_LIFETIME_RES = [
  /\b(?:s-)?max-?age\s*=\s*(?!0\b)/i,
  // Serves the stored copy at once and asks only afterwards, so a revoked
  // reader still gets it on that reuse.
  /\bstale-(?:while-revalidate|if-error)\s*=\s*(?!0\b)/i,
  /["']expires["']\s*[:,]/i,
  // `Expires` needs no quotes as an object key. Capitalised only: prose says
  // "the copy expires:" in lowercase.
  /(?:^|[\s{,])Expires\s*:/,
  // Without Cache-Control, Last-Modified alone lets a browser reuse a
  // response for a fraction of its age without asking (RFC 9111 §4.2.2).
  /["']last-modified["']\s*[:,]/i,
];

// Lines that match the pattern but are not an HTTP cache, each with the
// reason. An entry that no longer matches its file fails, so it cannot
// outlive the line it excuses.
const NOT_AN_HTTP_CACHE: Array<{ file: string; includes: string; reason: string }> = [
  {
    file: "components/ui/sidebar.tsx",
    includes: "document.cookie",
    reason: "a cookie's own lifetime attribute, not a response the browser caches",
  },
  {
    file: "components/settings-license.tsx",
    includes: "formatLicenseDate(license.expiresAt)",
    reason: "the license's expiry date as visible text, not a header",
  },
];

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.has(name)) out.push(...productionSources(full));
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("browser cache is scoped to the session (#1286)", () => {
  it("recognises every way of writing a lifetime, and not what merely looks like one", () => {
    // A narrowed pattern passes the scan below in silence, so its reach is
    // pinned here line by line.
    const lifetimes = [
      `"cache-control": "private, max-age=3600"`,
      "`private, max-age=${n}`",
      `"cache-control": "public, s-maxage=60"`,
      `"cache-control": "private, max-age=0, stale-while-revalidate=3600"`,
      `"cache-control": "private, no-cache, stale-if-error=86400"`,
      `"expires": new Date().toUTCString(),`,
      `headers.set("Expires", when);`,
      `headers: { Expires: new Date().toUTCString() },`,
      `    Expires: later,`,
      `"last-modified": stat.mtime.toUTCString(),`,
      `headers.set("Last-Modified", when);`,
    ];
    const notLifetimes = [
      `"cache-control": "private, max-age=0"`,
      `"cache-control": "private, no-cache"`,
      `"cache-control": "private, max-age=0, stale-while-revalidate=0"`,
      "document.cookie = `sidebar=1; path=/; expires=${d}`;",
      ` * reading the document until the copy expires: the grant was removed`,
    ];
    const hits = (line: string) => CACHE_LIFETIME_RES.some((re) => re.test(line));
    expect(lifetimes.filter((l) => !hits(l))).toEqual([]);
    expect(notLifetimes.filter(hits)).toEqual([]);
  });

  it("pairs every cache lifetime with Vary: Cookie", () => {
    expect(sessionScopedCacheHeaders(60)).toEqual({
      "cache-control": "private, max-age=60",
      vary: "Cookie",
    });
  });

  it("finds no cache lifetime written outside the helper", () => {
    const files = productionSources(webSrcDir);
    // A walker that finds nothing would pass in silence.
    expect(files.length).toBeGreaterThan(200);

    // next.config.ts is scanned too: a header set there wins over the route
    // handler's (see the X-Frame-Options gate), so a cache lifetime written
    // there would override everything the helper declares.
    const roots = ["../server.ts", "../next.config.ts"].map((f) => path.resolve(webSrcDir, f));

    const offenders: string[] = [];
    const usedExemptions = new Set<string>();
    for (const file of [...files, ...roots]) {
      if (file === HELPER) continue;
      const rel = path.relative(webSrcDir, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CACHE_LIFETIME_RES.some((re) => re.test(line))) return;
        const exemption = NOT_AN_HTTP_CACHE.find(
          (e) => e.file === rel && line.includes(e.includes)
        );
        if (exemption) {
          usedExemptions.add(exemption.file);
          return;
        }
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "Use sessionScopedRevalidateHeaders(etag) from @/lib/session-scoped-cache for access-checked content, or sessionScopedCacheHeaders() if the route is in MAY_SET_A_LIFETIME"
    ).toEqual([]);
    expect(
      NOT_AN_HTTP_CACHE.map((e) => e.file).filter((f) => !usedExemptions.has(f)),
      "stale exemption: it no longer matches a line in its file"
    ).toEqual([]);
  });

  it("lets only the listed routes give a response a lifetime", () => {
    // A lifetime lets the browser reuse its copy without asking, so revoking
    // an agent's grant, or a reader's access to the agent, does not stop a
    // browser that already holds the response. A served document must be
    // revalidated on every reuse (sessionScopedRevalidateHeaders) instead.
    // Matched by name anywhere in the file, an aliased import included.
    // This bounds who may set a LIFETIME; it does not prove that a route
    // without one sends a validator. That is the serving routes' own tests'
    // job — and harmless if missed, since without Last-Modified there is no
    // heuristic freshness either (the scan above treats that header as a
    // lifetime too).
    const MAY_SET_A_LIFETIME: Array<{ file: string; reason: string }> = [
      {
        file: "app/api/models/capabilities/route.ts",
        reason:
          "the model catalog, identical for every member; a revoked user loses nothing by seeing it a minute longer",
      },
    ];
    const files = productionSources(webSrcDir).filter((f) => f !== HELPER);
    const users = files
      .filter((file) => /\bsessionScopedCacheHeaders\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(webSrcDir, file));
    const allowed = MAY_SET_A_LIFETIME.map((e) => e.file);

    expect(
      users.filter((f) => !allowed.includes(f)),
      "Use sessionScopedRevalidateHeaders(etag), or add the route to MAY_SET_A_LIFETIME with a reason"
    ).toEqual([]);
    expect(
      allowed.filter((f) => !users.includes(f)),
      "stale entry: the file no longer sets a lifetime"
    ).toEqual([]);
  });
});
