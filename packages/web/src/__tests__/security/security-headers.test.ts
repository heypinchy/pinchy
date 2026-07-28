import { describe, it, expect } from "vitest";
import nextConfig from "../../../next.config";
import { matchesSource, resolveHeader } from "@/test-helpers/next-headers";

/**
 * Security test: ensures all required security headers are configured.
 *
 * If this test fails, it means someone removed or forgot to add
 * important security headers in next.config.ts.
 */

const REQUIRED_HEADERS = [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "X-XSS-Protection",
  "Referrer-Policy",
  "Permissions-Policy",
  // HSTS is handled by the reverse proxy — not set in next.config.ts.
];

describe("Security headers", () => {
  it("should have a headers function in next.config.ts", () => {
    expect(nextConfig.headers).toBeDefined();
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("should include all required security headers", async () => {
    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers.map((h) => h.key));

    for (const required of REQUIRED_HEADERS) {
      expect(allHeaders, `Missing security header: ${required}`).toContain(required);
    }
  });

  it("should set X-Frame-Options to DENY", async () => {
    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers);
    const xfo = allHeaders.find((h) => h.key === "X-Frame-Options");

    expect(xfo?.value).toBe("DENY");
  });

  it("should set X-Content-Type-Options to nosniff", async () => {
    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers);
    const xcto = allHeaders.find((h) => h.key === "X-Content-Type-Options");

    expect(xcto?.value).toBe("nosniff");
  });

  it("should not include HSTS header (handled by reverse proxy)", async () => {
    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers.map((h) => h.key));
    expect(allHeaders).not.toContain("Strict-Transport-Security");
  });
});

/**
 * The tests above ask whether a header value appears ANYWHERE in the config.
 * That is not the same question as "what does this URL actually get", and the
 * gap between them is not theoretical: agent-delivered artifacts (#703 / #788)
 * shipped unviewable because the `artifacts` route inherited the global
 * `X-Frame-Options: DENY` while its own handler set SAMEORIGIN. The route's
 * header LOSES — next.config wins — so a route-level test asserting the route's
 * own header stayed green while every delivered PDF rendered as a blank pane
 * with net::ERR_BLOCKED_BY_RESPONSE.
 *
 * So these tests resolve a concrete path the way Next.js does (see
 * `@/test-helpers/next-headers`) and assert the value that path ends up with.
 * The companion guard `frame-options-route-coverage.test.ts` enforces the same
 * property for EVERY serving route, so a new one cannot ship without an entry.
 */

describe("matchesSource", () => {
  it("treats a `:param` as exactly one segment", () => {
    const source = "/api/agents/:agentId/uploads/:filename";
    expect(matchesSource(source, "/api/agents/a1/uploads/report.pdf")).toBe(true);
    // Two segments where the pattern allows one.
    expect(matchesSource(source, "/api/agents/a1/uploads/nested/report.pdf")).toBe(false);
  });

  it("treats a literal dot as a dot, not a wildcard", () => {
    // Without escaping, `^/sw.js$` matches `/swXjs` — a rule silently applying
    // to a path it was never meant to cover.
    expect(matchesSource("/sw.js", "/sw.js")).toBe(true);
    expect(matchesSource("/sw.js", "/swXjs")).toBe(false);
  });

  it("expands the `(.*)` catch-all across segments", () => {
    expect(matchesSource("/(.*)", "/chat/agent-1")).toBe(true);
    expect(matchesSource("/(.*)", "/")).toBe(true);
  });
});

describe("X-Frame-Options as a given URL actually receives it", () => {
  it("keeps DENY for ordinary pages", () => {
    // The whole point of the relaxations below is that they stay narrow.
    return expect(resolveHeader("/chat/agent-1", "X-Frame-Options")).resolves.toBe("DENY");
  });

  it("relaxes to SAMEORIGIN for the uploaded-file route the attachment preview embeds", () => {
    return expect(
      resolveHeader("/api/agents/agent-1/uploads/report.pdf", "X-Frame-Options")
    ).resolves.toBe("SAMEORIGIN");
  });

  it("relaxes to SAMEORIGIN for the artifacts route an agent-delivered file opens from", () => {
    // Same AttachmentPreview component, same <embed>, only the source zone
    // differs (FileSourceContext = "artifacts"). Without this the browser
    // blocks the embed outright and the user sees a blank viewer pane, even
    // though the route serves a valid 200 application/pdf.
    return expect(
      resolveHeader("/api/agents/agent-1/artifacts/delivered-report.pdf", "X-Frame-Options")
    ).resolves.toBe("SAMEORIGIN");
  });

  it("relaxes to SAMEORIGIN for the workspace-file route a cited source opens from", () => {
    // Without this the browser blocks the <embed> outright and the viewer shows
    // a blank pane — the route can serve perfect bytes and the user sees nothing.
    return expect(
      resolveHeader("/api/agents/agent-1/workspace-file", "X-Frame-Options")
    ).resolves.toBe("SAMEORIGIN");
  });

  it("relaxes no route beyond the file-serving ones", async () => {
    // The list is the spec — deliberately exhaustive, so widening the
    // relaxation to a route that renders HTML is a failing test, not a review
    // catch. `frame-options-route-coverage.test.ts` keeps it tied to the
    // routes that actually exist.
    const entries = await nextConfig.headers!();
    const relaxed = entries
      .filter((e) => e.headers.some((h) => h.key === "X-Frame-Options" && h.value === "SAMEORIGIN"))
      .map((e) => e.source);

    expect(relaxed.sort()).toEqual([
      "/api/agents/:agentId/artifacts/:filename",
      "/api/agents/:agentId/uploads/:filename",
      "/api/agents/:agentId/workspace-file",
    ]);
  });
});
