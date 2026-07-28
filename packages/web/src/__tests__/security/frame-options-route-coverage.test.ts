// packages/web/src/__tests__/security/frame-options-route-coverage.test.ts
//
// Enforcement guard for a pair of lists that must move together:
//
//   1. API routes that serve content meant to be EMBEDDED same-origin
//      (the AttachmentPreview <embed>, the PDF lightbox), which declare that
//      posture with `x-frame-options: SAMEORIGIN` in their own response.
//   2. The per-route SAMEORIGIN relaxations in next.config.ts.
//
// A route in (1) without an entry in (2) serves perfect bytes that the browser
// refuses to render — the config's global `X-Frame-Options: DENY` wins over the
// handler's header, so the user gets a blank viewer pane and
// net::ERR_BLOCKED_BY_RESPONSE. It has shipped twice: the KB citation viewer
// and agent-delivered artifacts (#703 / #788). Both times every test was green,
// because route tests assert the header the HANDLER sets.
//
// This guard closes the class rather than the instance: add a serving route,
// forget the config entry, and CI fails here with the exact line to add.
//
// See AGENTS.md § "Embeddable Serving Routes Need A next.config Entry".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveHeader, routeFileToSource } from "@/test-helpers/next-headers";

const APP_DIR = resolve(__dirname, "../../app");
const API_DIR = join(APP_DIR, "api");

/**
 * Helpers that set the SAMEORIGIN posture on a caller's behalf. A route calling
 * one of these serves embeddable content without naming the header itself, so a
 * plain grep for the header string would miss it — which is precisely the
 * artifacts route that shipped broken.
 *
 * Matched on the SYMBOL, not the module: `serve-workspace-file` also exports
 * `SERVABLE_DELIVERED_MIMES`, and a route importing only that does not serve
 * anything.
 */
const SAMEORIGIN_HELPERS = ["streamWorkspaceFile"];

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

/** Routes whose responses are meant to be embedded same-origin. */
function findEmbeddableServingRoutes(): { file: string; source: string; samplePath: string }[] {
  const found: { file: string; source: string; samplePath: string }[] = [];
  for (const file of walkRouteFiles(API_DIR)) {
    const content = readFileSync(file, "utf8");
    const setsHeaderDirectly = /["']x-frame-options["']\s*:\s*["']SAMEORIGIN["']/i.test(content);
    const usesHelper = SAMEORIGIN_HELPERS.some((helper) => content.includes(`${helper}(`));
    if (!setsHeaderDirectly && !usesHelper) continue;
    found.push({
      file: relative(APP_DIR, file),
      ...routeFileToSource(relative(APP_DIR, file)),
    });
  }
  return found;
}

describe("embeddable serving routes are relaxed in next.config.ts", () => {
  it("finds the serving routes at all (guard against a scanner that silently matches nothing)", () => {
    // A scanner that finds zero routes would pass every assertion below while
    // enforcing nothing — the failure mode of every grep-based guard.
    const routes = findEmbeddableServingRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(3);
  });

  it.each(findEmbeddableServingRoutes())(
    "$file resolves to SAMEORIGIN, not the global DENY",
    async ({ file, source, samplePath }) => {
      const resolved = await resolveHeader(samplePath, "X-Frame-Options");
      expect(
        resolved,
        `${file} serves embeddable content but ${samplePath} resolves to ${resolved}.\n` +
          `Add this to next.config.ts headers(), AFTER the /(.*) catch-all:\n` +
          `  { source: "${source}", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] }`
      ).toBe("SAMEORIGIN");
    }
  );

  it("relaxes no route that does not serve embeddable content", async () => {
    // The other drift direction: a relaxation must not outlive the route that
    // justified it, and must never be broadened to a route that renders HTML.
    const entries = await (await import("../../../next.config")).default.headers!();
    const relaxed = entries
      .filter((e) => e.headers.some((h) => h.key === "X-Frame-Options" && h.value === "SAMEORIGIN"))
      .map((e) => e.source);
    const serving = findEmbeddableServingRoutes().map((r) => r.source);

    expect([...relaxed].sort()).toEqual([...serving].sort());
  });
});
