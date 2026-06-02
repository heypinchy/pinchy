import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
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
];

describe("auth config consistency", () => {
  for (const file of CONFIG_FILES) {
    describe(file, () => {
      const filePath = resolve(PROJECT_ROOT, file);

      for (const { pattern, replacement } of LEGACY_PATTERNS) {
        it(`should not reference legacy ${pattern.source}`, () => {
          // Read inside the test so a missing CONFIG_FILES entry surfaces as
          // a loud failure, not a silent skip. Every path listed above ships
          // with the repo; if one disappears, that's a real regression and
          // the test should turn the CI red.
          const content = readFileSync(filePath, "utf-8");
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

  // BETTER_AUTH_URL was removed in #352. Investigation confirmed it had no
  // functional consumer in Pinchy: Better Auth's baseURL only feeds OAuth
  // callbacks (unused), email verification / password-reset links (Pinchy
  // sends no Better Auth emails — reset links are built client-side from
  // window.location.origin), and trustedOrigins (which we drive from Domain
  // Lock + request host). The guards below are negative on purpose, so the
  // misleading env plumbing can't be reintroduced as cargo-cult config.
  it("docker-compose.yml should NOT reference BETTER_AUTH_URL (#352 — no functional consumer)", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "docker-compose.yml"), "utf-8");
    expect(content).not.toContain("BETTER_AUTH_URL");
  });

  it(".env.example should NOT document BETTER_AUTH_URL (#352)", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, ".env.example"), "utf-8");
    expect(content).not.toContain("BETTER_AUTH_URL");
  });

  it("server.ts should NOT emit a BETTER_AUTH_URL startup warning (#352)", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "packages/web/server.ts"), "utf-8");
    expect(content).not.toContain("BETTER_AUTH_URL");
    expect(content).not.toContain("getBetterAuthUrlStartupWarning");
  });

  it("the auth-env-warning module is removed (#352)", () => {
    expect(existsSync(resolve(PROJECT_ROOT, "packages/web/src/lib/auth-env-warning.ts"))).toBe(
      false
    );
  });

  it("auth.ts should configure trustedOrigins for dynamic origin detection", () => {
    const content = readFileSync(resolve(PROJECT_ROOT, "packages/web/src/lib/auth.ts"), "utf-8");
    expect(content).toContain("trustedOrigins");
  });

  it("auth.ts should set Better Auth minPasswordLength to PASSWORD_MIN_LENGTH (defense in depth)", () => {
    // Without this, Better Auth's own /sign-up and /change-password paths
    // would fall back to its default minPasswordLength of 8, undermining
    // the length policy that our route validators enforce. See issue #234.
    const content = readFileSync(resolve(PROJECT_ROOT, "packages/web/src/lib/auth.ts"), "utf-8");
    expect(content).toContain("PASSWORD_MIN_LENGTH");
    expect(content).toMatch(/minPasswordLength:\s*PASSWORD_MIN_LENGTH/);
  });

  describe("PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT — security guardrail", () => {
    // The env var disables Better Auth's rate limit on /sign-in/* (3 req / 10s
    // per IP). It MUST only ever appear in the E2E-only compose overlay, never
    // in production compose, so a misplaced copy-paste can't accidentally turn
    // off brute-force protection on a live deployment.
    const ENV_VAR = "PINCHY_E2E_DISABLE_AUTH_RATE_LIMIT";

    it(`docker-compose.yml must NOT set ${ENV_VAR} (production compose)`, () => {
      const content = readFileSync(resolve(PROJECT_ROOT, "docker-compose.yml"), "utf-8");
      expect(
        content,
        `${ENV_VAR} found in docker-compose.yml — that file deploys to production. Move it to docker-compose.e2e.yml.`
      ).not.toContain(ENV_VAR);
    });

    it(`docker-compose.dev.yml must NOT set ${ENV_VAR} (dev compose; rate limit is off in dev anyway)`, () => {
      const content = readFileSync(resolve(PROJECT_ROOT, "docker-compose.dev.yml"), "utf-8");
      expect(content).not.toContain(ENV_VAR);
    });

    it(`docker-compose.e2e.yml DOES set ${ENV_VAR} (the only legitimate location)`, () => {
      const content = readFileSync(resolve(PROJECT_ROOT, "docker-compose.e2e.yml"), "utf-8");
      expect(content).toContain(ENV_VAR);
    });
  });
});
