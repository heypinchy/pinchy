import { defineConfig } from "@playwright/test";

/**
 * Playwright config for pinchy-email (Gmail) E2E.
 * Assumes the full Docker stack with gmail-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.email-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/email",
  // Run only the OAuth-provider specs here. e2e/email is shared with
  // playwright.imap.config.ts, which claims exactly the specs listed below:
  // they need the GreenMail + imap-mock stack (docker-compose.imap-test.yml)
  // that this job does NOT bring up, so running them here fails with "IMAP
  // mock not ready".
  //
  // This is a denylist, so a NEW spec added to e2e/email runs here by default.
  // Keep it in sync with playwright.imap.config.ts's testMatch — the two
  // partition one directory, and a spec must appear in exactly one of them.
  testIgnore: ["email-imap.spec.ts", "inbox-sweep.spec.ts"],
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
