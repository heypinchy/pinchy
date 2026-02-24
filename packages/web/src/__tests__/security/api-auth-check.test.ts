import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative } from "path";

/**
 * Security test: ensures all API routes have authentication checks.
 *
 * Every API route must use either:
 * - auth() from @/lib/auth
 * - requireAdmin() from @/lib/api-auth
 * - requireAuth() from @/lib/require-auth
 *
 * Routes that are intentionally public must be listed in PUBLIC_ROUTES.
 */

const AUTH_PATTERNS = [
  /\bauth\(\)/,
  /\brequireAdmin\(\)/,
  /\brequireAuth\(\)/,
  /\bgetAgentWithAccess\(/,
];

// Routes that are intentionally public (no auth required)
const PUBLIC_ROUTES = [
  "api/auth/[...nextauth]/route.ts",
  "api/setup/route.ts",
  "api/setup/status/route.ts",
  "api/invite/claim/route.ts",
  "api/health/route.ts",
  "api/health/openclaw/route.ts",
];

function findRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

describe("API route authentication", () => {
  const apiDir = resolve(__dirname, "../../app/api");
  const routeFiles = findRouteFiles(apiDir);
  const relativeFiles = routeFiles.map((f) => relative(resolve(apiDir, ".."), f));

  it("should find API route files", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const routeFile of relativeFiles) {
    const isPublic = PUBLIC_ROUTES.some((pub) => routeFile.includes(pub));

    if (isPublic) continue;

    it(`${routeFile} should have an authentication check`, () => {
      const content = readFileSync(resolve(apiDir, "..", routeFile), "utf-8");
      const hasAuth = AUTH_PATTERNS.some((pattern) => pattern.test(content));

      expect(
        hasAuth,
        `Route ${routeFile} is missing an authentication check. Add auth(), requireAdmin(), or requireAuth(). If this route is intentionally public, add it to PUBLIC_ROUTES in this test file.`
      ).toBe(true);
    });
  }
});
