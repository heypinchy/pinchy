// packages/web/eval/eval-selftest.spec.ts
//
// Eval-v1 (pinchy#669) self-test: deterministic, no paid API. Dispatches
// against the in-repo fake-ollama server using the Hetzner self-test
// triggers (see fake-ollama-server.ts) and ASSERTS the happy run grades
// pass, the false-success run grades fail. Safe for CI. Proves the whole
// pipeline — dispatch, audit collection, normalization, grading — is wired
// correctly before trusting it against real models.
//
// Run with `pnpm eval:selftest` (routes here via playwright.eval.config.ts's
// EVAL_MODE-driven testMatch). See eval-models.spec.ts for the real-model
// sweep and packages/web/eval/README.md for the full harness description.
import { test, expect } from "@playwright/test";
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
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../e2e/shared/dispatch-probe";
import { stackDbUrl } from "../e2e/shared/stack-db";
import {
  FAKE_OLLAMA_HETZNER_HAPPY_TRIGGER,
  FAKE_OLLAMA_HETZNER_FALSE_SUCCESS_TRIGGER,
  FAKE_OLLAMA_PORT,
  FAKE_OLLAMA_MODEL,
  startFakeOllama,
  stopFakeOllama,
} from "../e2e/shared/fake-ollama/fake-ollama-server";
import { hetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { resetOdooMock, seedOdooBaseline, pinAgentModel, runOnce } from "./run-eval";
import { setupHetznerAgent } from "./eval-shared";

test.describe("Eval-v1: Hetzner invoice scenario (selftest)", () => {
  let cookie: string;
  let agentId: string;
  let restoreSettings: (() => Promise<void>) | undefined;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300_000);
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await waitForGraphMock();
    cookie = await login();

    await startFakeOllama();
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5437);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    const setup = await setupHetznerAgent(cookie);
    agentId = setup.agentId;

    await pinAgentModel(cookie, agentId, FAKE_OLLAMA_MODEL);
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
    await waitForAgentDispatchable(
      (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
      agentId
    );
  });

  test.afterAll(async () => {
    if (agentId) await pinchyDelete(`/api/agents/${agentId}`, cookie);
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test("happy trajectory (fake-ollama Hetzner sequence) grades passed:true", async ({ page }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);
    // The fake sequence's odoo_create call always writes a fresh move, so the
    // scorecard math (task-completion) is exercised against the real Odoo
    // mock, not a canned fixture.

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      prompt: `${FAKE_OLLAMA_HETZNER_HAPPY_TRIGGER}: ${hetznerInvoiceScenario.userPrompt}`,
    });

    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  });

  test("false-success trajectory grades failed with false-success tag", async ({ page }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      prompt: `${FAKE_OLLAMA_HETZNER_FALSE_SUCCESS_TRIGGER}: ${hetznerInvoiceScenario.userPrompt}`,
    });

    expect(result.passed).toBe(false);
    expect(result.tags).toContain("false-success");
  });
});
