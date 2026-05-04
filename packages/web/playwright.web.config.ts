import { defineConfig } from "@playwright/test";

/**
 * Playwright config for pinchy-web (Brave Search) E2E.
 * Assumes the full Docker stack with brave-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.web-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/web",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
