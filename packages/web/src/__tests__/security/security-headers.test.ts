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
  // Strict-Transport-Security is only included when HTTPS is configured
  // (BETTER_AUTH_URL starts with https://). On plain HTTP it breaks browsers.
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

  it("should not include HSTS header when BETTER_AUTH_URL is not set", async () => {
    const originalUrl = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_URL;

    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers.map((h) => h.key));
    expect(allHeaders).not.toContain("Strict-Transport-Security");

    process.env.BETTER_AUTH_URL = originalUrl;
  });

  it("should not include HSTS header when BETTER_AUTH_URL is http://", async () => {
    const originalUrl = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "http://pinchy.example.com";

    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers.map((h) => h.key));
    expect(allHeaders).not.toContain("Strict-Transport-Security");

    process.env.BETTER_AUTH_URL = originalUrl;
  });

  it("should include HSTS header when BETTER_AUTH_URL is https://", async () => {
    const originalUrl = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://pinchy.example.com";

    const headerEntries = await nextConfig.headers!();
    const allHeaders = headerEntries.flatMap((entry) => entry.headers);
    const hsts = allHeaders.find((h) => h.key === "Strict-Transport-Security");
    expect(hsts).toBeDefined();
    expect(hsts?.value).toContain("max-age=");

    process.env.BETTER_AUTH_URL = originalUrl;
  });
});
