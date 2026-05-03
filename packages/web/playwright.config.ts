import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/telegram/**", "**/odoo/**", "**/integration/**"],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:7778",
    trace: "retain-on-failure",
    // CSRF gate (issue #235) requires Origin/Referer on state-changing API
    // requests. Playwright's APIRequestContext doesn't auto-set Origin, so we
    // send it globally — same-origin to baseURL — to mimic a real browser.
    extraHTTPHeaders: {
      Origin: "http://localhost:7778",
    },
  },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command:
      "DATABASE_URL=postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test BETTER_AUTH_SECRET=test-secret-for-e2e-at-least-32chars ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001 AUDIT_HMAC_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef WORKSPACE_BASE_PATH=/tmp/pinchy-test-workspaces OPENCLAW_SECRETS_PATH=/tmp/pinchy-e2e-secrets/secrets.json PORT=7778 node -r ./server-preload.cjs --import tsx server.ts",
    port: 7778,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  },
});
