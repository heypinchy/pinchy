import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Eval-v1 (pinchy#669), the model-reliability eval
 * harness. EVAL_MODE selects which spec file runs — a config-level
 * `testMatch` switch rather than a runtime `test.skip(condition)` inside a
 * single spec, so neither mode's tests are ever "collected then skipped"
 * (and so the repo's no-untracked-skips drift guard, which only recognizes
 * `.skipIf(` as a conditional gate, has nothing to flag):
 *
 *   EVAL_MODE=selftest (default) — eval-selftest.spec.ts. Deterministic,
 *     fake-ollama-backed, safe for CI, makes real assertions.
 *
 *   EVAL_MODE=models — eval-models.spec.ts. Dispatches against real Ollama
 *     Cloud models, needs OLLAMA_CLOUD_API_KEY. No per-run assertions —
 *     writes a scorecard instead.
 *
 * Both modes assume the Docker eval stack is running:
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
 *     -f docker-compose.eval.yml up --build -d
 *
 * Long default timeout: a single Hetzner-scenario run is a 4-tool chain over
 * a real chat dispatch (list -> read -> download attachment -> create Odoo
 * move), and "models" mode dispatches N runs per candidate model
 * sequentially — see each spec's own per-test test.setTimeout() calls for
 * the actual per-test budget; this is the Playwright-level floor.
 */
const EVAL_MODE = process.env.EVAL_MODE === "models" ? "models" : "selftest";

export default defineConfig({
  testDir: ".",
  testMatch: EVAL_MODE === "models" ? /eval-models\.spec\.ts/ : /eval-selftest\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 300_000,
  use: {
    baseURL: process.env.PINCHY_URL || "http://localhost:7777",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
