// packages/web/src/__tests__/security/internal-routes-gateway-auth.test.ts
//
// The `/api/internal/` prefix is a security CLAIM, not a naming convention:
// two gates in the request path — the domain-lock host check
// (src/server/host-check.ts) and the CSRF gate (src/server/csrf-check.ts) —
// wave the whole prefix through on the grounds that everything under it is
// bearer-token traffic from an OpenClaw plugin, arriving over a Docker-internal
// hostname with no browser involved.
//
// This guard is what makes that claim true. Every route under app/api/internal
// must authenticate with `validateGatewayToken`, or be named in host-check's
// LOOPBACK_ONLY_EXEMPT_PATHS (unauthenticated, and therefore reachable only
// from the container's own loopback).
//
// Why it exists: the host check used to enumerate the exempt paths by hand, and
// the list drifted — `/api/internal/channel-messages` was never added, so in
// production pinchy-transcript's capture POST was rejected with 403 and
// Pinchy's owned transcript stayed empty (#599). Replacing the list with a
// prefix rule removes that drift, but only by moving the burden here: a
// session-authed browser route dropped under `/api/internal/` would now inherit
// both exemptions silently. `POST /api/internal/audit/background-run` was
// exactly that route, and moved to `/api/audit/background-run` with this guard.
//
// See AGENTS.md § "A Hand-Maintained List That Mirrors Code Will Be Wrong".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LOOPBACK_ONLY_EXEMPT_PATHS } from "@/server/host-check";

const API_INTERNAL_DIR = resolve(__dirname, "../../app/api/internal");

function walkRouteFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkRouteFiles(fullPath));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      result.push(fullPath);
    }
  }
  return result;
}

/** `app/api/internal/foo/[id]/bar/route.ts` → `/api/internal/foo/[id]/bar`. */
function routeFileToPath(file: string): string {
  const rel = relative(resolve(__dirname, "../../app"), file);
  return "/" + rel.replace(/\/route\.tsx?$/, "");
}

const routes = walkRouteFiles(API_INTERNAL_DIR).map((file) => ({
  path: routeFileToPath(file),
  source: readFileSync(file, "utf8"),
}));

describe("every /api/internal route is gateway-token authenticated", () => {
  it("finds the internal routes at all", () => {
    // A broken walker that returns nothing would let every assertion below pass
    // in silence — the failure mode this whole family of guards exists to stop.
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it.each(routes.map((r) => r.path))("%s", (path) => {
    const route = routes.find((r) => r.path === path)!;
    if (LOOPBACK_ONLY_EXEMPT_PATHS.includes(path)) return;

    expect(
      route.source.includes("validateGatewayToken"),
      `${path} is under /api/internal/, which the domain-lock host check and the CSRF gate ` +
        `both exempt on the grounds that it is bearer-token plugin traffic. It does not call ` +
        `validateGatewayToken. Either authenticate it with the gateway token, or move it out ` +
        `of /api/internal/ (a session-authed browser route belongs elsewhere).`
    ).toBe(true);
  });

  it("keeps the loopback-only exemptions pointing at routes that exist", () => {
    // A stale exemption is the same drift one level up: it would keep waving a
    // path through long after the unauthenticated route behind it was renamed.
    for (const path of LOOPBACK_ONLY_EXEMPT_PATHS) {
      expect(
        routes.some((r) => r.path === path),
        `${path} is exempted as an unauthenticated loopback-only route, but no such route exists.`
      ).toBe(true);
    }
  });
});
