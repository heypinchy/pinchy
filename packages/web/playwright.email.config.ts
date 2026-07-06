import { defineConfig } from "@playwright/test";

/**
 * Playwright config for pinchy-email (Gmail) E2E.
 * Assumes the full Docker stack with gmail-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.email-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/email",
  // Run only the OAuth-provider specs here. email-imap.spec.ts needs the
  // GreenMail + imap-mock stack (docker-compose.imap-test.yml) which this
  // job does NOT bring up — it runs under playwright.imap.config.ts /
  // test:e2e:imap instead. Without this, the imap spec would run here against
  // a stack with no imap mock and fail with "IMAP mock not ready".
  testIgnore: "email-imap.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
    // Capture diagnostics on failure so flakes surface ground truth rather
    // than another guessing round. `retain-on-failure` writes the artifact
    // only when a test fails — zero cost on green runs.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
