import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Telegram E2E tests.
 *
 * Unlike the main config, this does NOT spawn a web server or manage databases.
 * It assumes the full Docker stack is already running:
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
 */
export default defineConfig({
  testDir: "./e2e/telegram",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120000, // 2 min per test (LLM responses can be slow)
  // Skip @llm tests in CI — they require real Anthropic API auth that
  // OpenClaw's per-agent auth-profiles system doesn't pick up from env vars.
  // Pairing tests (no LLM needed) run in all environments.
  grepInvert: process.env.CI ? /@llm|@channel-restart/ : undefined,
  use: {
    baseURL: "http://localhost:7777",
  },
  // No webServer — tests run against the Docker Compose stack
  // No globalSetup/teardown — Docker Compose handles lifecycle
});
