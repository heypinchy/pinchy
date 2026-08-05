// packages/web/src/__tests__/lib/app-route-link-coverage.test.ts
//
// Every in-app link and `router.push` must name a page the App Router really
// serves.
//
// A route that does not exist is a 404 with nothing red behind it: the build
// succeeds, the type checker has no opinion about a string, and a unit test
// written next to the navigation asserts the very path the implementation
// invented. #1149 shipped `router.push("/agents/<id>/settings?tab=instructions")`
// with a passing test pinning that exact URL, against a tree whose only agent
// settings page is `/chat/<id>/settings`. The whole feature landed on a 404,
// twice green.
//
// This is the same rule as § "Embeddable Serving Routes Need A next.config
// Entry" in AGENTS.md, one layer up: assert what a concrete URL resolves to,
// not what a component asked for.
//
// Known limitations, so nobody reads a green run as more than it is:
//   - Only literal and template-literal targets are checked. `router.push(url)`
//     with a computed value is invisible, and guessing what a variable holds is
//     how a guard starts lying.
//   - Only page routes. `/api/**` is skipped — those are route handlers, with
//     their own guards.
//   - A dynamic segment matches anything, so a link that puts a chat id where
//     an agent id belongs still passes. This catches a path that cannot
//     resolve, not one that resolves to the wrong record.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectServedRoutes,
  collectSourceFiles,
  extractLinkReferences,
  isPublicAsset,
  matchesRoute,
  stripComments,
} from "./app-route-extraction";

const SRC_DIR = resolve(__dirname, "../..");
const APP_DIR = resolve(SRC_DIR, "app");
const PUBLIC_DIR = resolve(SRC_DIR, "../public");
const REPO_WEB = resolve(SRC_DIR, "..");

describe("in-app links resolve to a real page route", () => {
  const routes = collectServedRoutes(APP_DIR);
  const references = collectSourceFiles(SRC_DIR).flatMap((file) =>
    extractLinkReferences(readFileSync(file, "utf8"), file.slice(REPO_WEB.length + 1))
  );

  it("found a real corpus on both sides", () => {
    // A walker that stops finding things would otherwise pass in silence,
    // which is how a coverage gate becomes decoration.
    expect(routes.length).toBeGreaterThan(10);
    expect(references.length).toBeGreaterThan(30);
  });

  it("has no link to a page that does not exist", () => {
    const broken = references
      .filter(({ path }) => !path.startsWith("/api/"))
      .filter(({ path }) => !isPublicAsset(path, PUBLIC_DIR))
      .filter(({ path }) => !matchesRoute(path, routes))
      .map(({ file, raw, path }) => `${file}: ${raw}  (resolves to ${path})`);

    expect(broken, `Known page routes:\n  ${routes.join("\n  ")}`).toEqual([]);
  });
});

describe("stripComments", () => {
  it("drops a navigation written inside a comment", () => {
    // `src/lib/return-to.ts` documents a phishing payload as prose, complete
    // with a `router.push(...)` call. Reporting that would be reporting the
    // explanation instead of the code.
    const code = stripComments(`
      /** Next turns router.push("/\\t/evil.com") into a hard navigation. */
      const real = "/settings";
    `);
    expect(code).not.toContain("evil.com");
    expect(code).toContain('"/settings"');
  });

  it("keeps a URL that merely contains a double slash", () => {
    expect(stripComments(`const u = "https://example.com/x";`)).toContain("https://example.com/x");
  });

  it("does not truncate a line at a regex literal's escaped slashes", () => {
    // `/^https?:\/\//i` is real code in three modules. Reading its second
    // escaped slash as a line comment would silently blind the scan to
    // everything after it.
    const code = stripComments(`if (/^https?:\\/\\//i.test(u)) push("/settings");`);
    expect(code).toContain('push("/settings")');
  });

  it("leaves a comment marker inside a string alone", () => {
    expect(stripComments(`const s = "a // b";`)).toContain("a // b");
  });
});

describe("matchesRoute", () => {
  const routes = ["/", "/agents", "/agents/new", "/chat/*", "/chat/*/settings", "/share/**"];

  it("matches a dynamic segment", () => {
    expect(matchesRoute("/chat/*/settings", routes)).toBe(true);
  });

  it("rejects a path with the right shape under the wrong prefix", () => {
    expect(matchesRoute("/agents/*/settings", routes)).toBe(false);
  });

  it("rejects a path with an extra segment", () => {
    expect(matchesRoute("/agents/new/extra", routes)).toBe(false);
  });

  it("matches anything below a catch-all", () => {
    expect(matchesRoute("/share/a/b/c", routes)).toBe(true);
  });
});
