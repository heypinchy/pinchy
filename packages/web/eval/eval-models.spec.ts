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
import { hetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import {
  resetOdooMock,
  seedOdooBaseline,
  pinAgentModel,
  runOnce,
  writeScorecard,
  requireOllamaCloudApiKey,
  candidateModelsFromEnv,
  runsPerModelFromEnv,
} from "./run-eval";
import { setupHetznerAgent } from "./eval-shared";
import type { RunResult } from "../src/lib/eval/types";

const DEFAULT_CANDIDATES = [
  "ollama-cloud/kimi-k2.6",
  "ollama-cloud/gemma4:31b",
  "ollama-cloud/glm-4.7",
];

test.describe("Eval-v1: model sweep (real Ollama Cloud)", () => {
  test.beforeAll(() => {
    requireOllamaCloudApiKey();
  });

  test("sweeps candidate models N times each and writes a scorecard", async ({ page }) => {
    test.setTimeout(60 * 60_000);

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
    const allRuns: RunResult[] = [];

    for (const model of candidates) {
      await pinAgentModel(cookie, agentId, model);
      await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
      await waitForAgentDispatchable(
        (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
        agentId
      );

      for (let i = 0; i < n; i++) {
        await resetGraphMock();
        await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
        await resetOdooMock();
        await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);

        await loginViaUI(page, getAdminEmail(), getAdminPassword());
        const result = await runOnce({ page, cookie, agentId, model });
        allRuns.push(result);
      }
    }

    await pinchyDelete(`/api/agents/${agentId}`, cookie);

    const scorecard = await writeScorecard("hetzner-invoice-models", allRuns);
    console.log(`[eval] wrote scorecard for ${String(allRuns.length)} runs:`, scorecard);
  });
});
