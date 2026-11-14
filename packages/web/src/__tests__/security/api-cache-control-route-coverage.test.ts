// packages/web/src/__tests__/security/api-cache-control-route-coverage.test.ts
//
// Every authenticated JSON API response must carry `Cache-Control: no-store`
// (GET /api/users, /api/settings, /api/agents/<id> shipped with no header at
// all, so a shared cache or the browser's back/forward cache was free to keep
// user data). The rule lives in next.config.ts, and a config header OVERRIDES
// whatever a handler sets — so a blanket `/api/(.*)` rule would clobber the
// routes that set a caching policy of their own (conditional-GET file serving,
// the models capability cache). Those routes are excluded by negative
// matching, and this guard keeps the exclusion list and the code in step:
//
//   - a route that declares its own policy must resolve to NO config value;
//   - every other route must resolve to `no-store`.
//
// Limit: the exclusion is per ROUTE, so this guard cannot see a per-BRANCH gap.
// An excluded route's non-byte responses (JSON, error text) are only no-store
// if the handler says so itself; workspace-file does (agent-workspace-file-rows
// .test.ts asserts it), but a new branch added to an excluded route is on its
// author and its reviewer, not on this test.
//
// Like the X-Frame-Options guard, it asserts what a concrete URL resolves to,
// not what a handler asked for.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { matchesSource, resolveHeader } from "@/test-helpers/next-headers";
import { relativeReExports } from "@/test-helpers/route-reexports";

const APP_DIR = resolve(__dirname, "../../app");
const API_DIR = join(APP_DIR, "api");

/** Symbols that put a route on its own caching policy. */
const OWN_POLICY_MARKERS = [
  "streamWorkspaceFile(",
  "sessionScopedCacheHeaders(",
  "sessionScopedRevalidateHeaders(",
];

function walkRouteFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) result.push(...walkRouteFiles(fullPath));
    else if (entry === "route.ts" || entry === "route.tsx") result.push(fullPath);
  }
  return result;
}

function hasOwnPolicy(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const content = readFileSync(file, "utf8");
  if (OWN_POLICY_MARKERS.some((m) => content.includes(m))) return true;
  return relativeReExports(file, content).some(
    ({ target, names }) =>
      names.some(({ exported }) => exported === "GET") && hasOwnPolicy(target, seen)
  );
}

/** Concrete sample URL for a route file; catch-alls get two segments. */
function samplePath(routeFile: string): string {
  const segments = routeFile
    .replace(/\\/g, "/")
    .replace(/\/route\.tsx?$/, "")
    .split("/")
    .filter(Boolean)
    .flatMap((s) =>
      /^\[\.\.\..+]$/.test(s) ? ["sample", "sample"] : /^\[.+]$/.test(s) ? ["sample"] : [s]
    );
  return `/${segments.join("/")}`;
}

const routes = walkRouteFiles(API_DIR).map((file) => ({
  file: relative(APP_DIR, file),
  path: samplePath(relative(APP_DIR, file)),
  ownPolicy: hasOwnPolicy(file),
}));

describe("matchesSource custom-regex params", () => {
  it("honours a negative lookahead inside :param(...)", () => {
    const source = "/api/:path((?!skip/).*)";
    expect(matchesSource(source, "/api/users")).toBe(true);
    expect(matchesSource(source, "/api/a/b/c")).toBe(true);
    expect(matchesSource(source, "/api/skip/x")).toBe(false);
  });

  it("matches case-insensitively, as Next does (sensitive: false)", () => {
    expect(matchesSource("/api/users", "/API/Users")).toBe(true);
    expect(matchesSource("/api/:path((?!skip/).*)", "/api/SKIP/x")).toBe(false);
  });

  it.each(["/api/:path*", "/api/:path+", "/api/:path?", "/api/(foo|bar)", "/api/(.+)"])(
    "throws on syntax it does not model: %s",
    (source) => {
      expect(() => matchesSource(source, "/api/x")).toThrow(/does not model/);
    }
  );
});

describe("API responses carry Cache-Control: no-store unless the route owns its policy", () => {
  it("finds the routes at all (guard against a scanner that matches nothing)", () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => r.ownPolicy).length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    "/api/users",
    "/api/settings",
    "/api/agents/some-id",
    "/api/audit/export",
    "/api/usage/export",
    "/api/auth/sign-in/email",
  ])("%s resolves to no-store", async (path) => {
    expect(await resolveHeader(path, "Cache-Control")).toBe("no-store");
  });

  it.each(routes.filter((r) => !r.ownPolicy))(
    "$file resolves to no-store",
    async ({ file, path }) => {
      const resolved = await resolveHeader(path, "Cache-Control");
      expect(
        resolved,
        `${file} (${path}) resolves to ${resolved}. If it sets its own caching policy, ` +
          `add it to the exclusion in next.config.ts and mark it in OWN_POLICY_MARKERS; ` +
          `otherwise the next.config.ts /api rule has stopped matching it.`
      ).toBe("no-store");
    }
  );

  it.each(routes.filter((r) => r.ownPolicy))(
    "$file keeps its own policy (config sets no Cache-Control)",
    async ({ file, path }) => {
      const resolved = await resolveHeader(path, "Cache-Control");
      expect(
        resolved,
        `${file} sets its own caching policy but ${path} resolves to ${resolved} from ` +
          `next.config.ts, which overrides the handler. Exclude it from the /api no-store rule.`
      ).toBeUndefined();
    }
  );
});
