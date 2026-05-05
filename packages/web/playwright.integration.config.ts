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
  webServer: {
    command: [
      `DATABASE_URL=${INTEGRATION_DB_URL}`,
      "BETTER_AUTH_SECRET=test-secret-for-integration-at-least-32chars",
      "ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001",
      "AUDIT_HMAC_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      // Connect to OpenClaw running in the integration Docker stack
      "OPENCLAW_WS_URL=ws://localhost:18790",
      "PINCHY_E2E_GATEWAY_TOKEN=pinchy-integration-gateway-token",
      // OpenClaw runs in Docker while Pinchy runs on the host in this suite.
      // Internal plugin callbacks therefore use a Docker-internal hostname,
      // which also exercises Domain Lock host exemptions.
      "PINCHY_INTERNAL_URL=http://host.docker.internal:7779",
      // Domain Lock normally restarts Pinchy so cookie security settings pick
      // up the new domain. The integration suite sets and clears Domain Lock
      // inside a running test process.
      "PINCHY_E2E_DISABLE_DOMAIN_RESTART=1",
      // Docker Desktop can only reach host fake Ollama through host.docker.internal,
      // which OpenClaw treats as an authenticated non-local provider.
      "PINCHY_E2E_OLLAMA_LOCAL_API_KEY=1",
      // Config path shared with OpenClaw container (host path = container path after mount)
      "OPENCLAW_CONFIG_PATH=/tmp/pinchy-integration-openclaw/openclaw.json",
      // Workspaces also under the shared dir so OpenClaw can read SOUL.md / AGENTS.md
      "WORKSPACE_BASE_PATH=/tmp/pinchy-integration-openclaw/workspaces",
      "OPENCLAW_WORKSPACE_PREFIX=/root/.openclaw/workspaces",
      // Device identity for OpenClaw connection (defaults to /app/secrets which is Docker-only)
      "DEVICE_IDENTITY_PATH=/tmp/pinchy-integration-openclaw/device-identity.json",
      // Secrets file: host writes here, same path is bind-mounted into OpenClaw container
      "OPENCLAW_SECRETS_PATH=/tmp/pinchy-integration-secrets/secrets.json",
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
