import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Config consistency test: ensures deployment and infrastructure files
 * reference Better Auth env vars (not legacy NextAuth ones).
 *
 * Catches issues like docker-compose or CI config still using
 * NEXTAUTH_SECRET/NEXTAUTH_URL after migrating to Better Auth.
 */

const PROJECT_ROOT = resolve(__dirname, "../../../../..");

const CONFIG_FILES = [
  "docker-compose.yml",
  "docker-compose.dev.yml",
  ".github/workflows/ci.yml",
  "packages/web/server-preload.cjs",
  "packages/web/playwright.config.ts",
];

const LEGACY_PATTERNS = [
  { pattern: /NEXTAUTH_SECRET/g, replacement: "BETTER_AUTH_SECRET" },
  { pattern: /NEXTAUTH_URL/g, replacement: "N/A (configure domain via Settings → Security)" },
  { pattern: /AUTH_TRUST_HOST/g, replacement: "N/A (not needed by Better Auth)" },
  { pattern: /(?<![A-Z_])AUTH_SECRET(?![A-Z_])/g, replacement: "BETTER_AUTH_SECRET" },
  { pattern: /BETTER_AUTH_URL/g, replacement: "N/A (configure domain via Settings → Security)" },
];

describe("auth config consistency", () => {
  for (const file of CONFIG_FILES) {
    describe(file, () => {
      const filePath = resolve(PROJECT_ROOT, file);
      let content: string;

      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        // File might not exist in some environments (e.g., CI without full checkout)
        it.skip(`${file} not found`, () => {});
        return;
      }

      for (const { pattern, replacement } of LEGACY_PATTERNS) {
        it(`should not reference legacy ${pattern.source}`, () => {
          const matches = content.match(pattern);
          expect(
            matches,
            `${file} still references ${pattern.source}. Replace with ${replacement}.`
          ).toBeNull();
        });
      }
    });
  }

  it("server-preload.cjs should set BETTER_AUTH_SECRET", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "packages/web/server-preload.cjs"), "utf-8");
    expect(content).toContain("BETTER_AUTH_SECRET");
  });

  it("docker-compose.dev.yml should set BETTER_AUTH_SECRET", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "docker-compose.dev.yml"), "utf-8");
    expect(content).toContain("BETTER_AUTH_SECRET");
  });

  it("auth.ts should configure trustedOrigins for dynamic origin detection", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "packages/web/src/lib/auth.ts"), "utf-8");
    expect(content).toContain("trustedOrigins");
  });
});
