// packages/web/eval/eval-models.spec.ts
//
// Eval-v1 (pinchy#669) real-model sweep: dispatches the Hetzner-invoice
// scenario against real Ollama Cloud candidate models, N times each
// (EVAL_N, default 5). Requires OLLAMA_CLOUD_API_KEY. Collects RunResults
// and writes a scorecard to packages/web/eval/results/<label>.json — NO
// per-run assertions. This mode MEASURES model behavior; it does not gate
// CI on it (unlike eval-selftest.spec.ts, which does assert).
//
// Run with `OLLAMA_CLOUD_API_KEY=... pnpm eval:models` (routes here via
// playwright.eval.config.ts's EVAL_MODE-driven testMatch). See
// packages/web/eval/README.md for how to read a scorecard.
import { test } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  login,
  pinchyGet,
  pinchyDelete,
} from "../e2e/odoo/helpers";
import {
  waitForGraphMock,
  resetGraphMock,
  seedGraphMockMessages,
  getAdminEmail,
  getAdminPassword,
} from "../e2e/email/helpers";
import {
  loginViaUI,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../e2e/shared/dispatch-probe";
import { stackDbUrl } from "../e2e/shared/stack-db";
import { hetznerInvoiceScenario, type HetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";
import {
  resetOdooMock,
  seedOdooBaseline,
  pinAgentModel,
  runOnce,
  writeScorecard,
  appendRunResult,
  readExistingRuns,
  requireOllamaCloudApiKey,
  candidateModelsFromEnv,
  runsPerModelFromEnv,
  injectOdooCreateFailure,
  injectOdooCreateSilentSuccess,
} from "./run-eval";
import { setupHetznerAgent } from "./eval-shared";
import type { RunResult } from "../src/lib/eval/types";

const DEFAULT_CANDIDATES = [
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/gemma4:31b",
  "ollama-cloud/glm-4.7",
];

/**
 * The scenarios the sweep runs for every candidate model. `label` becomes
 * both the `RunResult.scenario` tag and the scorecard filename, so
 * "vendor-bill-created" results and "honest-failure" (failure-injection)
 * results stay in separate, clearly separable outputs even though they share
 * the same candidate-model list and per-model run count.
 */
const SWEEP_SCENARIOS: Array<{
  label: string;
  scenario: HetznerInvoiceScenario;
  /** Per-run setup beyond the standard reset+seed, e.g. injecting a mock failure. */
  extraSetup?: () => Promise<void>;
}> = [
  { label: "hetzner-invoice-models", scenario: hetznerInvoiceScenario },
  {
    label: "hetzner-invoice-rejected-models",
    scenario: hetznerInvoiceRejectedScenario,
    extraSetup: injectOdooCreateFailure,
  },
  {
    label: "hetzner-invoice-silent-failure-models",
    scenario: hetznerInvoiceSilentFailureScenario,
    extraSetup: injectOdooCreateSilentSuccess,
  },
];

test.describe("Eval-v1: model sweep (real Ollama Cloud)", () => {
  test.beforeAll(() => {
    requireOllamaCloudApiKey();
  });

  test("sweeps candidate models N times each and writes a scorecard", async ({ page }) => {
    // A full sweep (many models × scenarios × N real dispatches) runs for many
    // hours; the 60-min default was far too short (a run got killed mid-sweep).
    // Default 24h, env-overridable, and the sweep RESUMES from the JSONL so a
    // timeout/crash never restarts from zero.
    test.setTimeout(Number(process.env.EVAL_TEST_TIMEOUT_MS) || 24 * 60 * 60_000);

    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await waitForGraphMock();
    const cookie = await login();

    const apiKey = requireOllamaCloudApiKey();
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5437);
    const { default: postgres } = await import("postgres");
    const sql = postgres(dbUrl);
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES ('default_provider', 'ollama-cloud', false)
      ON CONFLICT (key) DO UPDATE SET value = 'ollama-cloud'
    `;
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES ('ollama_cloud_api_key', ${apiKey}, false)
      ON CONFLICT (key) DO UPDATE SET value = ${apiKey}
    `;
    await sql.end();

    const candidates = candidateModelsFromEnv(DEFAULT_CANDIDATES);
    const n = runsPerModelFromEnv(5);

    const { agentId } = await setupHetznerAgent(cookie);

    // Each scenario in SWEEP_SCENARIOS gets its OWN run list + scorecard file
    // (label) so "vendor-bill-created" and "honest-failure" (failure-
    // injection) results never mix into one buildScorecard grouping — the
    // grouping key is `run.model`, which repeats across scenarios by design
    // (the sweep runs every model against every scenario).
    // Optional EVAL_SCENARIO (comma-separated labels) runs a subset of the
    // scenarios, so a long sweep can be split into shorter, more survivable
    // per-scenario invocations (each accumulates into its own JSONL).
    const scenarioFilter = process.env.EVAL_SCENARIO?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const scenariosToRun = scenarioFilter
      ? SWEEP_SCENARIOS.filter((s) => scenarioFilter.includes(s.label))
      : SWEEP_SCENARIOS;

    for (const { label, scenario, extraSetup } of scenariosToRun) {
      // Resume: seed the scorecard with runs already persisted to the JSONL
      // (from a prior interrupted invocation) and skip models already at N.
      const existingRuns = await readExistingRuns(label);
      const scenarioRuns: RunResult[] = [...existingRuns];

      for (const model of candidates) {
        const alreadyDone = existingRuns.filter((r) => r.model === model).length;
        if (alreadyDone >= n) continue; // fully covered by a previous run

        await pinAgentModel(cookie, agentId, model);
        await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
        await waitForAgentDispatchable(
          (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
          agentId
        );

        for (let i = alreadyDone; i < n; i++) {
          await resetGraphMock();
          await seedGraphMockMessages([scenario.graphSeedMessage]);
          await resetOdooMock();
          await seedOdooBaseline(scenario.odooBaseline);
          if (extraSetup) await extraSetup();

          await loginViaUI(page, getAdminEmail(), getAdminPassword());
          const runStart = Date.now();
          try {
            const result = await runOnce({
              page,
              cookie,
              agentId,
              model,
              scenario,
              scenarioLabel: label,
            });
            scenarioRuns.push(result);
            await appendRunResult(label, result);
          } catch (err) {
            // A hung/looping run (dispatch idle-timeout) or any per-run error
            // must NOT abort the whole sweep or discard the scenario's data. A
            // hang is itself a reliability signal (some models spiral when a
            // tool result contradicts their plan), so record it as a graded
            // run-timeout failure and keep going.
            const latencyMs = Date.now() - runStart;
            console.warn(
              `[eval] run ${String(i + 1)}/${String(n)} for ${model} / ${label} recorded as run-timeout: ${String(err)}`
            );
            const timeoutResult: RunResult = {
              model,
              passed: false,
              tags: ["run-timeout"],
              notes: [String(err)],
              latencyMs,
              scenario: label,
            };
            scenarioRuns.push(timeoutResult);
            await appendRunResult(label, timeoutResult);
          }
        }
      }

      const scorecard = await writeScorecard(label, scenarioRuns);
      console.log(
        `[eval] wrote scorecard "${label}" for ${String(scenarioRuns.length)} runs:`,
        scorecard
      );
    }

    await pinchyDelete(`/api/agents/${agentId}`, cookie);
  });
});
