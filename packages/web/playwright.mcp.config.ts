import { defineConfig } from "@playwright/test";

/**
 * Playwright config for native MCP (credential-proxy) E2E tests.
 * Assumes the full Docker stack with mcp-mock is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.mcp-test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/mcp",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
  },
});
