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
 * It also flags the literal in a comment: say "a short private cache" in
 * prose instead.
 */

const webSrcDir = path.resolve(__dirname, "../..");
const HELPER = path.join(webSrcDir, "lib", "session-scoped-cache.ts");
const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules", "test-helpers"]);
const CACHE_LIFETIME_RE = /\b(?:private|public)\s*,\s*(?:s-)?max-?age\s*=/gi;

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

  it("finds no cache lifetime written outside the helper", () => {
    const files = productionSources(webSrcDir);
    // A walker that finds nothing would pass in silence.
    expect(files.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of [...files, path.resolve(webSrcDir, "../server.ts")]) {
      if (file === HELPER) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CACHE_LIFETIME_RE.test(line)) {
          offenders.push(`${path.relative(webSrcDir, file)}:${i + 1}: ${line.trim()}`);
        }
        CACHE_LIFETIME_RE.lastIndex = 0;
      });
    }
    expect(
      offenders,
      "Use sessionScopedCacheHeaders() from @/lib/session-scoped-cache instead"
    ).toEqual([]);
  });
});
