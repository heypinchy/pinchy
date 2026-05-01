// Vitest config for integration tests that run against a real PostgreSQL
// database. Distinct from vitest.config.ts (the unit suite) so:
//
//   - `pnpm test` stays fast and Docker-free.
//   - `pnpm test:db` opts into the slower, DB-backed suite.
//
// Locally, point the suite at the dev-stack Postgres on :5434 (or override
// VITEST_INTEGRATION_DB_URL). In CI, the workflow spins up its own Postgres
// service and sets VITEST_INTEGRATION_DB_URL accordingly.

import { defineConfig } from "vitest/config";
import path from "node:path";

const TEST_DB_URL =
  process.env.VITEST_INTEGRATION_DB_URL ??
  "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy_test_vitest";

export default defineConfig({
  test: {
    // node, not jsdom: integration tests exercise route handlers and DB code,
    // not React components.
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.{ts,tsx}"],
    setupFiles: ["./src/test-helpers/integration/setup.ts"],
    globalSetup: ["./src/test-helpers/integration/global-setup.ts"],
    // TRUNCATE in beforeEach makes parallel workers race on the shared DB.
    // Single-fork keeps things simple; if test count grows we can add per-
    // worker DB names and remove this.
    pool: "forks",
    forks: { singleFork: true },
    // 30s default per test — DB roundtrips + Better Auth signup are slower
    // than mocked unit tests but still fail-fast for genuine hangs.
    testTimeout: 30_000,
    env: {
      DATABASE_URL: TEST_DB_URL,
      // Better Auth requires a stable secret to construct the auth instance.
      // The value below is a fixed test-only string — never used in production.
      BETTER_AUTH_SECRET: "vitest-integration-secret-not-for-production-32",
      // Encryption helpers may be touched transitively; provide a deterministic
      // 32-byte hex key so module-load doesn't error.
      ENCRYPTION_KEY: "0".repeat(64),
      AUDIT_HMAC_SECRET: "deadbeef".repeat(8),
      NODE_ENV: "test",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "odoo-node": path.resolve(__dirname, "./node_modules/odoo-node"),
    },
  },
});
