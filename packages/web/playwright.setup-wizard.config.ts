import { defineConfig } from "@playwright/test";

/**
 * Playwright config for setup-wizard E2E (covers all LLM providers).
 * Assumes the full Docker stack with llm-providers-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.setup-wizard-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/setup-wizard",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
