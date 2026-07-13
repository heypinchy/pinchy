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
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceDistractorScenario } from "./scenarios/hetzner-invoice-distractor";
import { hetznerInvoiceConflictScenario } from "./scenarios/hetzner-invoice-conflict";
import {
  resetOdooMock,
  seedOdooBaseline,
  pinAgentModel,
  runOnce,
  writeScorecard,
  appendRunResult,
  readExistingRuns,
  candidateModelsFromEnv,
  runsPerModelFromEnv,
  injectOdooCreateFailure,
  injectOdooCreateSilentSuccess,
} from "./run-eval";
import { setupHetznerAgent } from "./eval-shared";
import type { RunResult } from "../src/lib/eval/types";

// The curated candidate set for a public open-weight agent-reliability
// benchmark (pinchy#669). Chosen for vendor breadth AND intra-family
// comparisons (does the bigger/newer sibling actually behave better on a real
// tool-using workflow?). Every id must exist in
// src/lib/ollama-cloud-models.ts TOOL_CAPABLE_OLLAMA_CLOUD_MODELS — that file
// is the source of truth for which models the /v1 path actually serves with
// working tool calls. Override per-run with EVAL_CANDIDATE_MODELS.
const DEFAULT_CANDIDATES = [
  // — original 8-model sweep (2026-07-11) —
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/gemma4:31b",
  "ollama-cloud/glm-4.7",
  "ollama-cloud/glm-5.2",
  "ollama-cloud/qwen3.5:397b",
  "ollama-cloud/minimax-m3",
  "ollama-cloud/gpt-oss:120b",
  "ollama-cloud/mistral-large-3:675b",
  // — breadth expansion: new vendors (DeepSeek, NVIDIA) + intra-family pairs —
  "ollama-cloud/deepseek-v3.2",
  "ollama-cloud/deepseek-v4-pro",
  "ollama-cloud/nemotron-3-ultra",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/glm-5.1",
  "ollama-cloud/minimax-m2.7",
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
  {
    // HARD scenario: the vendor bill is already recorded (seeded via the
    // scenario's odooBaseline, so no extraSetup injection needed). Correct =
    // verify with odoo_read/odoo_count and refrain from creating a duplicate.
    label: "hetzner-invoice-duplicate-models",
    scenario: hetznerInvoiceDuplicateScenario,
  },
  {
    // HARD scenario: a distractor payment-reminder email is planted alongside
    // the real invoice (via the scenario's extraGraphMessages, no extraSetup).
    // Correct = file the real invoice, not the reminder's number.
    label: "hetzner-invoice-distractor-models",
    scenario: hetznerInvoiceDistractorScenario,
  },
  {
    // HARD scenario: one email, but a prominent WRONG invoice number (subject +
    // reference line) competes with the labeled correct one. Correct = extract
    // the labeled Invoice number, not the prominent reference.
    label: "hetzner-invoice-conflict-models",
    scenario: hetznerInvoiceConflictScenario,
  },
];

test.describe("Eval-v1: model sweep (real Ollama Cloud)", () => {
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

    // Resolve the Ollama Cloud key from the environment, or fall back to the
    // copy already stored in the eval DB. The fallback is what lets an
    // unattended watchdog RESUME a sweep with NO secret on disk or in its
    // environment — the key only has to be supplied (via env) for the first run
    // that seeds it. See ~/.pinchy-eval-watchdog. Without either, fail loudly.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5437);
    const { default: postgres } = await import("postgres");
    const sql = postgres(dbUrl);
    const envKey = process.env.OLLAMA_CLOUD_API_KEY?.trim();
    if (envKey) {
      await sql`
        INSERT INTO settings (key, value, encrypted) VALUES ('ollama_cloud_api_key', ${envKey}, false)
        ON CONFLICT (key) DO UPDATE SET value = ${envKey}
      `;
    } else {
      const rows = await sql`SELECT value FROM settings WHERE key = 'ollama_cloud_api_key'`;
      if (rows.length === 0) {
        await sql.end();
        throw new Error(
          "No OLLAMA_CLOUD_API_KEY in the environment and none stored in the eval DB — " +
            "supply the key via env at least once so it can be seeded."
        );
      }
    }
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES ('default_provider', 'ollama-cloud', false)
      ON CONFLICT (key) DO UPDATE SET value = 'ollama-cloud'
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

    // Retry a stack/network operation a few times — over a multi-hour sweep a
    // host<->container fetch transiently fails ("TypeError: fetch failed")
    // without the containers crashing, and one such blip must not abort the run.
    const withRetry = async (fn: () => Promise<void>, what: string): Promise<void> => {
      const attempts = 4;
      for (let a = 1; a <= attempts; a++) {
        try {
          await fn();
          return;
        } catch (e) {
          if (a === attempts) throw e;
          console.warn(
            `[eval] ${what} attempt ${String(a)}/${String(attempts)} failed, retrying: ${String(e)}`
          );
          await new Promise((r) => setTimeout(r, 8000));
        }
      }
    };

    for (const { label, scenario, extraSetup } of scenariosToRun) {
      // Resume: seed the scorecard with runs already persisted to the JSONL
      // (from a prior interrupted invocation) and skip models already at N.
      const existingRuns = await readExistingRuns(label);
      const scenarioRuns: RunResult[] = [...existingRuns];

      for (const model of candidates) {
        const alreadyDone = existingRuns.filter((r) => r.model === model).length;
        if (alreadyDone >= n) continue; // fully covered by a previous run

        // Per-model setup (pin + stack readiness) with retry; if the stack
        // stays unreachable, SKIP this model rather than aborting the sweep.
        try {
          await withRetry(async () => {
            await pinAgentModel(cookie, agentId, model);
            await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
            await waitForAgentDispatchable(
              (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
              agentId
            );
          }, `setup ${model} / ${label}`);
        } catch (err) {
          console.warn(
            `[eval] SKIPPING ${model} / ${label} — setup failed after retries: ${String(err)}`
          );
          continue;
        }

        for (let i = alreadyDone; i < n; i++) {
          const runStart = Date.now();
          try {
            await withRetry(
              async () => {
                await resetGraphMock();
                await seedGraphMockMessages([
                  scenario.graphSeedMessage,
                  ...(scenario.extraGraphMessages ?? []),
                ]);
                await resetOdooMock();
                await seedOdooBaseline(scenario.odooBaseline);
                if (extraSetup) await extraSetup();
                await loginViaUI(page, getAdminEmail(), getAdminPassword());
              },
              `run-setup ${model} #${String(i)}`
            );
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
