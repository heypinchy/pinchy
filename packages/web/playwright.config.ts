import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // testIgnore is matched against absolute file paths. The bare patterns
  // `**/web/**` and `**/email/**` would erroneously match every spec under
  // `packages/web/...`, so we anchor them to `e2e/<suffix>/**`.
  testIgnore: [
    "**/telegram/**",
    "**/odoo/**",
    "**/integration/**",
    "**/e2e/web/**",
    "**/e2e/email/**",
    "**/e2e/setup-wizard/**",
  ],
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
      "DATABASE_URL=postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test BETTER_AUTH_SECRET=test-secret-for-e2e-at-least-32chars ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001 AUDIT_HMAC_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef WORKSPACE_BASE_PATH=/tmp/pinchy-test-workspaces OPENCLAW_CONFIG_PATH=/tmp/pinchy-e2e-config/openclaw.json OPENCLAW_DATA_PATH=/tmp/pinchy-e2e-config OPENCLAW_SECRETS_PATH=/tmp/pinchy-e2e-secrets/secrets.json PORT=7778 node -r ./server-preload.cjs --import tsx server.ts",
    // `helpers.ts` seeds `default_provider=anthropic` with a fake key, so the
    // first `/api/templates` render calls the REAL api.anthropic.com from the
    // runner and waits out DNS + TLS + a 401 before falling back to the offline
    // catalog. Measured at 5.2s on the merge-queue run that ejected PR #930,
    // against a 5s `toBeVisible` — and 109ms on the next call, once the 1h
    // provider cache was warm. That is a network round trip deciding whether a
    // test passes, which is the definition of a flake.
    //
    // Point the catalog at a port nothing listens on: the connection is refused
    // in microseconds and `fetchProviderModels` degrades to FALLBACK_MODELS —
    // byte for byte what the 401 produced, so no assertion changes meaning. The
    // suite asserts nothing about provider catalogs; it just must not depend on
    // the internet to render a page. Suites with a real catalog to serve use
    // `config/llm-providers-mock` instead (docker-compose.setup-wizard-test.yml).
    //
    // These vars feed `resolveProviderBaseUrl`, so they redirect every provider
    // URL — the key-validation probe and the `baseUrl` emitted into
    // openclaw.json too, not just the catalog fetch. Both are inert here: no
    // spec in this suite submits an API key, and this stack runs no OpenClaw. A
    // spec that later drives the wizard's key step would see a refused
    // connection where it expected a 401 — serve it a real catalog from
    // `config/llm-providers-mock` rather than dropping the override.
    env: {
      PINCHY_PROVIDER_BASEURL_ANTHROPIC: "http://127.0.0.1:1",
      PINCHY_PROVIDER_BASEURL_OPENAI: "http://127.0.0.1:1",
      PINCHY_PROVIDER_BASEURL_GOOGLE: "http://127.0.0.1:1",
      PINCHY_PROVIDER_BASEURL_OLLAMA_CLOUD: "http://127.0.0.1:1",
    },
    port: 7778,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  },
});
