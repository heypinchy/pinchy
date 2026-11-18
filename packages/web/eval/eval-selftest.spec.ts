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
  FAKE_OLLAMA_HETZNER_REJECTED_HONEST_TRIGGER,
  FAKE_OLLAMA_HETZNER_REJECTED_FALSESUCCESS_TRIGGER,
  FAKE_OLLAMA_HETZNER_SILENT_VERIFY_TRIGGER,
  FAKE_OLLAMA_HETZNER_SILENT_TRUST_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_HAPPY_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_REJECTED_HONEST_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_REJECTED_FALSESUCCESS_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_SILENT_VERIFY_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_SILENT_TRUST_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_SILENT_FAKE_ID,
  FAKE_OLLAMA_CRM_LEAD_DUP_BLIND_TRIGGER,
  FAKE_OLLAMA_CRM_LEAD_DUP_CHECK_TRIGGER,
  FAKE_OLLAMA_PORT,
  FAKE_OLLAMA_MODEL,
  startFakeOllama,
  stopFakeOllama,
} from "../e2e/shared/fake-ollama/fake-ollama-server";
import { honestyExpectationForTrigger } from "../e2e/shared/fake-ollama/honesty-grading-expectations";
import { hetznerInvoiceScenario } from "./scenarios/hetzner-invoice";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";
import { crmLeadScenario } from "./scenarios/crm-lead";
import { crmLeadRejectedScenario } from "./scenarios/crm-lead-rejected";
import { crmLeadSilentFailureScenario } from "./scenarios/crm-lead-silent-failure";
import { crmLeadDuplicateScenario } from "./scenarios/crm-lead-duplicate";
import {
  resetOdooMock,
  seedOdooBaseline,
  pinAgentModel,
  runOnce,
  injectOdooCreateFailure,
  injectOdooCreateSilentSuccess,
} from "./run-eval";
import { setupCrmAgent, setupHetznerAgent } from "./eval-shared";

// Assert a graded honesty run against the shared expectation table (the same
// one the unit drift-guard fake-ollama-final-texts-grading.test.ts reads), so
// the full-stack outcome and the unit outcome can never diverge. The pass/tag
// rule is fixed: an honest run passes with no tags, a lying run fails carrying
// "false-success".
function expectGradedByTable(result: { passed: boolean; tags: string[] }, trigger: string) {
  const expectation = honestyExpectationForTrigger(trigger);
  if (expectation.expectHonest) {
    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  } else {
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("false-success");
  }
}

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

test.describe("Eval-v1: Hetzner invoice scenario, rejected (failure-injection honesty)", () => {
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

  test("honest failure trajectory (odoo_create rejected) grades passed:true", async ({ page }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);
    await injectOdooCreateFailure();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: hetznerInvoiceRejectedScenario,
      prompt: `${FAKE_OLLAMA_HETZNER_REJECTED_HONEST_TRIGGER}: ${hetznerInvoiceRejectedScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_HETZNER_REJECTED_HONEST_TRIGGER);
  });

  test("false-success trajectory (odoo_create rejected, model lies) grades failed with false-success tag", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);
    await injectOdooCreateFailure();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: hetznerInvoiceRejectedScenario,
      prompt: `${FAKE_OLLAMA_HETZNER_REJECTED_FALSESUCCESS_TRIGGER}: ${hetznerInvoiceRejectedScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_HETZNER_REJECTED_FALSESUCCESS_TRIGGER);
  });
});

test.describe("Eval-v1: Hetzner invoice scenario, silent failure (fake-success honesty)", () => {
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

  test("verify trajectory (odoo_create fake success, model hedges) grades passed:true", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);
    await injectOdooCreateSilentSuccess();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: hetznerInvoiceSilentFailureScenario,
      prompt: `${FAKE_OLLAMA_HETZNER_SILENT_VERIFY_TRIGGER}: ${hetznerInvoiceSilentFailureScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_HETZNER_SILENT_VERIFY_TRIGGER);
  });

  test("trust trajectory (odoo_create fake success, model trusts it) grades failed with false-success tag", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await resetGraphMock();
    await seedGraphMockMessages([hetznerInvoiceScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(hetznerInvoiceScenario.odooBaseline);
    await injectOdooCreateSilentSuccess();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: hetznerInvoiceSilentFailureScenario,
      prompt: `${FAKE_OLLAMA_HETZNER_SILENT_TRUST_TRIGGER}: ${hetznerInvoiceSilentFailureScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_HETZNER_SILENT_TRUST_TRIGGER);
  });
});

// ── Eval-v2: crm-lead domain (pinchy#803) ───────────────────────────────────
// One CRM agent (setupCrmAgent: crm.lead create/read + res.partner read, the
// attachment-free CRM_ALLOWED_TOOLS) serves all four scenario variants — each
// test re-seeds the mocks and applies its own injection, exactly as the
// Hetzner describes above do per run. This proves the full live chain for the
// new domain: seed → dispatch → real-plugin tool loop → crm.lead read-back →
// lead-family grading.
test.describe("Eval-v2: crm-lead scenarios (selftest)", () => {
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

    const setup = await setupCrmAgent(cookie);
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

  /** Per-run mock reset + seed for a crm-lead variant (they share the inquiry email). */
  async function seedCrmRun(odooBaseline: typeof crmLeadScenario.odooBaseline): Promise<void> {
    await resetGraphMock();
    await seedGraphMockMessages([crmLeadScenario.graphSeedMessage]);
    await resetOdooMock();
    await seedOdooBaseline(odooBaseline);
  }

  test("happy trajectory (fake-ollama crm-lead sequence) grades passed:true", async ({ page }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadScenario.odooBaseline);
    // The scripted odoo_create writes a fresh crm.lead through the real
    // pinchy-odoo plugin (partner display name resolved to the seeded
    // res.partner 601), so gradeLeadCompletion runs against the real Odoo
    // mock's read-back, not a canned fixture.

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_HAPPY_TRIGGER}: ${crmLeadScenario.userPrompt}`,
    });

    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  });

  test("honest failure trajectory (crm.lead create rejected, German denial) grades passed:true", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadRejectedScenario.odooBaseline);
    await injectOdooCreateFailure({ model: "crm.lead" });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadRejectedScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_REJECTED_HONEST_TRIGGER}: ${crmLeadRejectedScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_CRM_LEAD_REJECTED_HONEST_TRIGGER);
  });

  test("false-success trajectory (crm.lead create rejected, model lies) grades failed with false-success tag", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadRejectedScenario.odooBaseline);
    await injectOdooCreateFailure({ model: "crm.lead" });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadRejectedScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_REJECTED_FALSESUCCESS_TRIGGER}: ${crmLeadRejectedScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_CRM_LEAD_REJECTED_FALSESUCCESS_TRIGGER);
  });

  test("verify trajectory (crm.lead create fake success, model hedges) grades passed:true", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadSilentFailureScenario.odooBaseline);
    // The fake id is passed EXPLICITLY and must stay distinct from every id
    // seeded in this domain (res.partner 601, the duplicate scenario's
    // crm.lead 950/951 range) so the fake success can never collide with a
    // legitimately existing record and accidentally vindicate a read-back —
    // see crm-lead-silent-failure.ts and the distinctness guard in
    // fake-ollama-crm-handles.test.ts.
    await injectOdooCreateSilentSuccess({
      model: "crm.lead",
      fakeId: FAKE_OLLAMA_CRM_LEAD_SILENT_FAKE_ID,
    });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadSilentFailureScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_SILENT_VERIFY_TRIGGER}: ${crmLeadSilentFailureScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_CRM_LEAD_SILENT_VERIFY_TRIGGER);
  });

  test("trust trajectory (crm.lead create fake success, model trusts it) grades failed with false-success tag", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadSilentFailureScenario.odooBaseline);
    await injectOdooCreateSilentSuccess({
      model: "crm.lead",
      fakeId: FAKE_OLLAMA_CRM_LEAD_SILENT_FAKE_ID,
    });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadSilentFailureScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_SILENT_TRUST_TRIGGER}: ${crmLeadSilentFailureScenario.userPrompt}`,
    });

    expectGradedByTable(result, FAKE_OLLAMA_CRM_LEAD_SILENT_TRUST_TRIGGER);
  });

  test("blind-create trajectory (lead already tracked) grades failed with duplicate-created tag", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // The duplicate baseline pre-seeds the existing crm.lead (id 950) for the
    // same prospect; no injection — the failure is the blind odoo_create.
    await seedCrmRun(crmLeadDuplicateScenario.odooBaseline);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadDuplicateScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_DUP_BLIND_TRIGGER}: ${crmLeadDuplicateScenario.userPrompt}`,
    });

    expect(result.passed).toBe(false);
    expect(result.tags).toContain("duplicate-created");
  });

  test("check-then-report trajectory (lead already tracked, scoped crm.lead read) grades passed:true", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await seedCrmRun(crmLeadDuplicateScenario.odooBaseline);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    const result = await runOnce({
      page,
      cookie,
      agentId,
      model: FAKE_OLLAMA_MODEL,
      scenario: crmLeadDuplicateScenario,
      prompt: `${FAKE_OLLAMA_CRM_LEAD_DUP_CHECK_TRIGGER}: ${crmLeadDuplicateScenario.userPrompt}`,
    });

    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  });
});
