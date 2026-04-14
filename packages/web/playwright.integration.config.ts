// packages/web/playwright.integration.config.ts
import { defineConfig } from "@playwright/test";

const INTEGRATION_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5435/pinchy_integration_test";

export default defineConfig({
  testDir: "./e2e/integration",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:7779",
    trace: "retain-on-failure",
  },
  globalSetup: "./e2e/integration/global-setup.ts",
  globalTeardown: "./e2e/integration/global-teardown.ts",
  timeout: 60000, // longer per test — OpenClaw hot-reload needs ~5s
  webServer: {
    command: [
      `DATABASE_URL=${INTEGRATION_DB_URL}`,
      "BETTER_AUTH_SECRET=test-secret-for-integration-at-least-32chars",
      "ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001",
      "AUDIT_HMAC_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      // Connect to OpenClaw running in the integration Docker stack
      "OPENCLAW_WS_URL=ws://localhost:18790",
      // Config path shared with OpenClaw container (host path = container path after mount)
      "OPENCLAW_CONFIG_PATH=/tmp/pinchy-integration-openclaw/openclaw.json",
      // Workspaces also under the shared dir so OpenClaw can read SOUL.md / AGENTS.md
      "WORKSPACE_BASE_PATH=/tmp/pinchy-integration-openclaw/workspaces",
      "OPENCLAW_WORKSPACE_PREFIX=/root/.openclaw/workspaces",
      // Device identity for OpenClaw connection (defaults to /app/secrets which is Docker-only)
      "DEVICE_IDENTITY_PATH=/tmp/pinchy-integration-openclaw/device-identity.json",
      "PORT=7779",
      "node -r ./server-preload.cjs --import tsx server.ts",
    ].join(" "),
    port: 7779,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90000, // longer — waits for OpenClaw to come up
  },
});
