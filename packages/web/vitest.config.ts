import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      // Every test under packages/plugins/pinchy-* runs here. The root
      // `pnpm test` script is `pnpm --filter @pinchy/web test`, so plugin
      // packages' own `vitest run` scripts are never invoked in CI — this
      // include is the single source of truth for plugin test coverage.
      // The plugin-test-coverage drift guard
      // (src/__tests__/lib/plugin-test-coverage.test.ts) enforces it.
      "../plugins/pinchy-*/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    // Integration tests run against a real PostgreSQL database via
    // vitest.integration.config.ts (`pnpm test:db`). Excluded here so
    // `pnpm test` stays fast and Docker-free. Convention: any file named
    // *.integration.test.ts opts into the DB-backed runner.
    exclude: [
      // Broad glob (not a bare "node_modules") so that *nested* node_modules
      // under sibling plugin packages are excluded too. The plugin include
      // glob below (`../plugins/pinchy-*/**/...`) otherwise traverses into
      // e.g. packages/plugins/pinchy-files/node_modules/*/test/*.test.js and
      // reports third-party suites as "No test suite found".
      "**/node_modules/**",
      "e2e",
      "**/*.integration.test.{ts,tsx,js,jsx}",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "odoo-node": path.resolve(__dirname, "./node_modules/odoo-node"),
    },
  },
});
