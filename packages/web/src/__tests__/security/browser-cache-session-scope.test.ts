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
 * A green run does not mean nothing is cacheable. A response without a
 * lifetime can still be cached heuristically when it carries Last-Modified;
 * nothing sets that today, and this guard does not look for it.
 */

const webSrcDir = path.resolve(__dirname, "../..");
const HELPER = path.join(webSrcDir, "lib", "session-scoped-cache.ts");
const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules", "test-helpers"]);
// Any non-zero max-age or s-maxage, in any position and whether written out or
// templated (`max-age=${n}`), and the stale-* extensions, which let the
// browser serve a stored copy on their own. The hyphen is required so a
// `maxAge = …` variable is not mistaken for a header. max-age=0 keeps nothing, so it is not
// a lifetime. Plus an `expires` header: a quoted object key, or the name
// passed to `headers.set("Expires", …)`.
const CACHE_LIFETIME_RES = [
  /\b(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\s*=(?!\s*0\b)/i,
  /["']expires["']\s*[:,]/i,
  // Route segment config: Next.js then writes s-maxage itself, so no header
  // literal appears in the source at all.
  /\bexport\s+const\s+revalidate\s*=(?!\s*(?:0|false)\b)/,
  /\bexport\s+const\s+dynamic\s*=\s*["']force-static["']/,
];
// An unquoted `Expires:` key is a valid Headers init too. In a .tsx file the
// same text is ordinary JSX copy (the license page shows "Expires: <date>"),
// so there it only counts right after `{` or `,`, where only an object key
// can stand. Route handlers are .ts, where it counts anywhere.
const UNQUOTED_EXPIRES_TS = /(?:^|[^\w$.])expires\s*:/i;
const UNQUOTED_EXPIRES_TSX = /[{,]\s*expires\s*:/i;

function setsCacheLifetime(file: string, line: string): boolean {
  if (CACHE_LIFETIME_RES.some((re) => re.test(line))) return true;
  return (file.endsWith(".tsx") ? UNQUOTED_EXPIRES_TSX : UNQUOTED_EXPIRES_TS).test(line);
}

// Lines that match the pattern but are not an HTTP cache, each with the
// reason. An entry that no longer matches its file fails, so it cannot
// outlive the line it excuses.
const NOT_AN_HTTP_CACHE: Array<{ file: string; includes: string; reason: string }> = [
  {
    file: "components/ui/sidebar.tsx",
    includes: "document.cookie",
    reason: "a cookie's own lifetime attribute, not a response the browser caches",
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
  it("pairs every cache lifetime with Vary: Cookie", () => {
    expect(sessionScopedCacheHeaders(60)).toEqual({
      "cache-control": "private, max-age=60",
      vary: "Cookie",
    });
  });

  it("refuses a lifetime that is not a positive whole number of seconds", () => {
    // Browsers ignore an invalid max-age (NaN, negative, fractional) and fall
    // back to their own heuristics, so a bad value must fail loudly here.
    for (const bad of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => sessionScopedCacheHeaders(bad)).toThrow(/positive whole number/);
    }
  });

  it("recognises each spelling of a lifetime, and not lookalikes", () => {
    const route = "app/api/x/route.ts";
    const page = "components/x.tsx";
    for (const line of [
      `headers: { "Cache-Control": "max-age=60, private" }`,
      "value: `private, max-age=${n}`",
      `value: "s-maxage=30"`,
      `headers: { Expires: d.toUTCString() }`,
      `  Expires: d.toUTCString(),`,
      `"expires": d.toUTCString()`,
      `res.headers.set("Expires", d.toUTCString())`,
      `headers: { "Cache-Control": "private, stale-while-revalidate=60" }`,
      `value: "stale-if-error=300"`,
      // Route segment config: Next.js then emits s-maxage itself, so no
      // header literal appears anywhere in the source.
      `export const revalidate = 60;`,
      `export const dynamic = "force-static";`,
    ]) {
      expect(setsCacheLifetime(route, line), line).toBe(true);
    }
    expect(setsCacheLifetime(page, `<Foo headers={{ Expires: d }} />`)).toBe(true);
    for (const line of [
      `const maxAge = 3600;`,
      `value: "no-cache, max-age=0, must-revalidate"`,
      `session.expires: 1`,
      `value: "stale-while-revalidate=0"`,
      `value: "private, max-age = 0"`,
      `export const revalidate = 0;`,
      `export const revalidate = false;`,
      `export const dynamic = "force-dynamic";`,
      `revalidatePath("/chat");`,
    ]) {
      expect(setsCacheLifetime(route, line), line).toBe(false);
    }
    expect(setsCacheLifetime(page, `  Expires: {formatLicenseDate(d)}`)).toBe(false);
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
    const usedExemptions = new Set<(typeof NOT_AN_HTTP_CACHE)[number]>();
    for (const file of [...files, ...roots]) {
      if (file === HELPER) continue;
      const rel = path.relative(webSrcDir, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!setsCacheLifetime(file, line)) return;
        const exemption = NOT_AN_HTTP_CACHE.find(
          (e) => e.file === rel && line.includes(e.includes)
        );
        if (exemption) {
          usedExemptions.add(exemption);
          return;
        }
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "Use sessionScopedCacheHeaders() from @/lib/session-scoped-cache instead"
    ).toEqual([]);
    expect(
      NOT_AN_HTTP_CACHE.filter((e) => !usedExemptions.has(e)).map(
        (e) => `${e.file}: ${e.includes}`
      ),
      "stale exemption: it no longer matches a line in its file"
    ).toEqual([]);
  });
});
