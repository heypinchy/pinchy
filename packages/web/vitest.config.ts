import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default, jsdom only where a test actually needs a DOM, declared
    // per file with `// @vitest-environment jsdom`.
    //
    // A DOM costs real time to build and tear down for every single test file,
    // and most files here never touch one: 152 of 714 web test files declare
    // jsdom, so ~79% used to pay for a browser they never opened. Measured on
    // one directory (87 files under src/__tests__/api), back to back on the same
    // machine: 326.3s with a global jsdom against 151.0s with node — and the
    // environment bucket collapsed from 1805s summed across workers to 96ms.
    //
    // This needs no drift guard: a file that needs a DOM and forgets the
    // docblock fails immediately and unmissably with "document is not defined".
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    // Vitest's 5s default left no headroom, and failures showed up scattered
    // across unrelated files whenever the machine was busy — enterprise-banner,
    // chat-switcher, auth-http-config, settings-page-oauth-removed — all of them
    // timeout-shaped rather than genuinely broken. That is a suite-wide lack of
    // slack, not a set of individual flakes, and each one cost an agent a full
    // re-run to rule out.
    //
    // Not guesswork: run in isolation on a busy machine, single React component
    // tests here measure 10.5s and 13.7s — every one of them a guaranteed
    // failure against a 5s limit and a clean pass with room to spare against
    // this one. A genuinely hanging test still fails, just 20s later.
    testTimeout: 20_000,
    hookTimeout: 40_000,
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
      // The eval harness's own guards over the CHECKED-IN dataset (they read
      // eval/data — no docker stack, no API keys, unlike `pnpm eval:models`).
      // `.test.ts` on purpose: playwright.eval.config.ts matches only the
      // Playwright specs, so the two runners never collide.
      "eval/**/*.test.ts",
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
      // picomatch (vitest's real glob matcher) does not let a leading `**`
      // span a `../` path segment, so the broad glob above alone does NOT
      // exclude nested node_modules reached via the plugin include glob's
      // relative `../plugins/pinchy-*/**` prefix (verified directly against
      // picomatch — see src/__tests__/lib/vitest-exclude-node-modules.test.ts).
      // This mirrors that prefix explicitly so it matches.
      "../plugins/pinchy-*/**/node_modules/**",
      "e2e",
      "**/*.integration.test.{ts,tsx,js,jsx}",
    ],
    server: {
      deps: {
        // The plugin-tool-coverage guard parses spec files with the TypeScript
        // compiler API. `typescript.js` carries a sourceMappingURL but ships no
        // .map, so letting vite transform it prints a ten-line ENOENT stack on
        // every run. Externalizing loads it through node directly — same
        // module, no transform, no noise.
        external: ["typescript"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "odoo-node": path.resolve(__dirname, "./node_modules/odoo-node"),
    },
  },
});
