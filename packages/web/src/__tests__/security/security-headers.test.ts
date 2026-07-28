import { describe, it, expect } from "vitest";
import nextConfig from "../../../next.config";

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
 * So these tests resolve a concrete path the way Next.js does and assert the
 * value that path ends up with.
 */

/** Converts a next.config `source` pattern to a matcher: `:param` is one segment, `(.*)` is anything. */
function matchesSource(source: string, path: string): boolean {
  const pattern = source
    .replace(/\(\.\*\)/g, " ANY ")
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+")
    .replace(/ ANY /g, ".*");
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * Later entries override earlier ones for the same key — which is exactly why
 * the relaxing rules are written after the catch-all in next.config.ts.
 */
async function resolveHeader(path: string, key: string): Promise<string | undefined> {
  const entries = await nextConfig.headers!();
  let value: string | undefined;
  for (const entry of entries) {
    if (!matchesSource(entry.source, path)) continue;
    for (const header of entry.headers) {
      if (header.key.toLowerCase() === key.toLowerCase()) value = header.value;
    }
  }
  return value;
}

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

  it("does not relax any route beyond those two", async () => {
    const entries = await nextConfig.headers!();
    const relaxed = entries
      .filter((e) => e.headers.some((h) => h.key === "X-Frame-Options" && h.value === "SAMEORIGIN"))
      .map((e) => e.source);

    expect(relaxed.sort()).toEqual([
      "/api/agents/:agentId/artifacts/:filename",
      "/api/agents/:agentId/uploads/:filename",
    ]);
  });
});
