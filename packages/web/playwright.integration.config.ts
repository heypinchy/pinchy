// packages/web/playwright.integration.config.ts
//
// Integration suite runs against the production-image Pinchy container
// (issue #196 Tier 3). Pinchy, OpenClaw, and Postgres are all started by
// `docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f
// docker-compose.integration.yml up --build -d` before Playwright runs;
// there is no Playwright-managed `webServer` here.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/integration",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:7779",
    trace: "retain-on-failure",
    // CSRF gate (issue #235) requires Origin/Referer on state-changing API
    // requests. Playwright's APIRequestContext doesn't auto-set Origin —
    // mirror the same baseURL value so cookie-authed POSTs aren't blocked.
    extraHTTPHeaders: {
      Origin: "http://localhost:7779",
    },
  },
  globalSetup: "./e2e/integration/global-setup.ts",
  globalTeardown: "./e2e/integration/global-teardown.ts",
  timeout: 120000, // 120s per test: integration tests run after a fresh
  // OpenClaw container restart, which may cause Pinchy to be mid-reconnect
  // (openclaw-node exponential backoff means the first successful retry
  // can land 30-60s after disconnect). The agent-chat test then has to
  // login, navigate, send a message, and wait for the round-trip — comfortably
  // inside 120s but tight inside 60s.
});
