import { defineConfig } from "@playwright/test";

/**
 * Playwright config for pinchy-email (Gmail) E2E.
 * Assumes the full Docker stack with gmail-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.email-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/email",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
