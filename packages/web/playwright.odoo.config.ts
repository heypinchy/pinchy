import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Odoo E2E tests.
 *
 * Assumes the full Docker stack is already running with the Odoo mock:
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.odoo-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/odoo",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
