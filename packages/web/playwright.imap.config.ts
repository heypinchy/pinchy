import { defineConfig } from "@playwright/test";

import { IMAP_ONLY_SPEC_MATCH } from "./e2e/email/imap-spec-patterns";

/**
 * Playwright config for pinchy-email (IMAP/SMTP) E2E.
 * Assumes the full Docker stack with greenmail + imap-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.imap-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/email",
  // See e2e/email/imap-spec-patterns.ts — this must claim exactly the specs
  // playwright.email.config.ts ignores. Both configs read the same module.
  testMatch: IMAP_ONLY_SPEC_MATCH,
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
