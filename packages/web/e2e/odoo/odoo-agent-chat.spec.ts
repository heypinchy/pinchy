import { test, expect, type Page, type TestInfo } from "@playwright/test";
import path from "path";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  seedOdooRecords,
  login,
  createOdooConnection,
  setAgentPermissions,
  getAdminEmail,
  getAdminPassword,
  pinchyGet,
  pinchyPatch,
  pinchyPost,
  pinchyDelete,
} from "./helpers";
import {
  FAKE_OLLAMA_ODOO_LIST_MODELS_TOOL_TRIGGER,
  FAKE_OLLAMA_ODOO_READ_DENIED_TRIGGER,
  FAKE_OLLAMA_ODOO_SCHEDULE_ACTIVITY_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_COMPLETE_ACTIVITY_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_RESCHEDULE_ACTIVITY_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_CONFIRM_ORDER_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_APPLY_INVENTORY_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_VALIDATE_PICKING_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_MARK_MO_DONE_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_SET_APPROVAL_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_RECONCILE_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_ATTACH_FILE_REF_TRIGGER,
  FAKE_OLLAMA_ODOO_ATTACH_FILE_REF_FILENAME,
  FAKE_OLLAMA_ODOO_DUP_BILL_REF,
  FAKE_OLLAMA_ODOO_CREATE_DUP_BLOCK_TRIGGER,
  FAKE_OLLAMA_ODOO_CREATE_DUP_OVERRIDE_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  pollAuditForEvent,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../shared/dispatch-probe";
import { stackDbUrl } from "../shared/stack-db";

const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

/** Poll /api/health/openclaw until `connected` is true or the timeout elapses. */
async function pollUntilOpenClawConnected(cookie: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await pinchyGet("/api/health/openclaw", cookie);
    if (res.ok) {
      const body = (await res.json()) as { connected?: boolean };
      if (body.connected) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test.describe("Odoo Agent Chat", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();

    // Wait for the OpenClaw WS bridge to connect before any test runs.
    // Fix D (skip writeConfigAtomic in WS path) removes the OC internal SIGUSR1
    // restart that previously forced a reconnect event early in startup. In slow
    // CI environments the initial connect can now take longer than the 10 s window
    // inside individual tests — guard it here once, with a generous timeout.
    const ocConnected = await pollUntilOpenClawConnected(cookie, 60_000);
    if (!ocConnected) {
      throw new Error("OpenClaw WS bridge not connected after 60 s — aborting test suite");
    }

    // Create Odoo connection
    const connRes = await createOdooConnection(cookie);
    expect(connRes.status).toBe(201);
    const connBody = await connRes.json();
    connectionId = connBody.id;

    // Get the first shared agent, or create one if none exists (fresh CI DB)
    const agentsRes = await pinchyGet("/api/agents", cookie);
    expect(agentsRes.status).toBe(200);
    const agents = await agentsRes.json();
    const sharedAgent = agents.find((a: { isPersonal: boolean }) => !a.isPersonal);
    if (sharedAgent) {
      agentId = sharedAgent.id;
    } else {
      const createRes = await pinchyPost(
        "/api/agents",
        { name: "Test Agent", templateId: "custom" },
        cookie
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      agentId = created.id;
    }
  });

  test("agent permissions are correctly saved and returned", async () => {
    // Set permissions
    const putRes = await setAgentPermissions(cookie, agentId, connectionId, [
      { model: "sale.order", operation: "read" },
    ]);
    expect(putRes.status).toBe(200);

    // Read them back
    const getRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(getRes.status).toBe(200);
    const integrations = await getRes.json();

    expect(integrations).toHaveLength(1);
    expect(integrations[0].connectionId).toBe(connectionId);
    expect(integrations[0].permissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ model: "sale.order", operation: "read" })])
    );
  });

  test("agent allowedTools includes Odoo tools after PATCH", async () => {
    const odooTools = [
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
    ];

    // PATCH the agent to allow Odoo tools
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: odooTools },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // Verify the agent now has those tools
    const getRes = await pinchyGet(`/api/agents/${agentId}`, cookie);
    expect(getRes.status).toBe(200);
    const agent = await getRes.json();

    expect(agent.allowedTools).toEqual(expect.arrayContaining(odooTools));
  });

  test("sync captures access rights per model", async () => {
    // Configure mock with specific access rights for sale.order
    const configRes = await fetch(`${MOCK_ODOO_URL}/control/access-rights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "sale.order": {
          read: true,
          create: true,
          write: false,
          unlink: false,
        },
      }),
    });
    expect(configRes.status).toBe(200);

    // Trigger sync
    const syncRes = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.success).toBe(true);
    expect(syncBody.models).toBeGreaterThan(0);

    // Verify the connection's cached data contains access rights
    const integrationsRes = await pinchyGet("/api/integrations", cookie);
    expect(integrationsRes.status).toBe(200);
    const integrations = await integrationsRes.json();
    const conn = integrations.find((c: { id: string }) => c.id === connectionId);
    expect(conn).toBeTruthy();
    expect(conn.data).toBeTruthy();

    // Find sale.order in the synced models and check its access rights
    const saleOrder = conn.data.models.find((m: { model: string }) => m.model === "sale.order");
    expect(saleOrder).toBeTruthy();
    expect(saleOrder.access).toEqual({
      read: true,
      create: true,
      write: false,
      delete: false,
    });
  });

  test("OpenClaw accepts the regenerated config when an Odoo agent gets permissions and tools", async () => {
    // This is the regression guard for the staging block (2026-05-04).
    // Pre-fix: setting Odoo permissions caused regenerateOpenClawConfig() to write a
    // config that OpenClaw rejected with INVALID_CONFIG (manifest required 'connection'
    // object, build.ts wrote 'connectionId' string since the API-callback migration).
    // Post-fix: the manifest matches the emitted shape; OpenClaw accepts the config.

    // Grant permissions — triggers regenerateOpenClawConfig() on the server.
    const putRes = await setAgentPermissions(cookie, agentId, connectionId, [
      { model: "crm.lead", operation: "read" },
    ]);
    expect(putRes.status).toBe(200);

    // Grant Odoo tools — a second config regen, this time plugins.entries["pinchy-odoo"] is emitted.
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: ["odoo_list_models", "odoo_describe_model", "odoo_read", "odoo_count"] },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // Poll /api/health/openclaw until OpenClaw reports connected=true after the
    // inotify hot-reload, with a generous timeout for slow CI environments.
    // The inotifywait grace period in start-openclaw.sh is 30 s; 10 s is enough
    // in practice (reload happens within ~1–2 s after the file write).
    const connected = await pollUntilOpenClawConnected(cookie, 10_000);
    expect(connected).toBe(true);

    // Double-check: the integration data has the connectionId shape (not legacy 'connection' object).
    const intRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(intRes.status).toBe(200);
    const integrations = await intRes.json();
    const odooInt = integrations.find(
      (i: { connectionId: string }) => i.connectionId === connectionId
    );
    expect(odooInt).toBeTruthy();
    expect(typeof odooInt.connectionId).toBe("string");
  });

  test("audit trail records tool usage via internal endpoint", async () => {
    // The tool-use audit endpoint requires a gateway token. We call it
    // directly with an Authorization header to verify the endpoint works.
    // In production, OpenClaw calls this endpoint after each tool execution.
    //
    // We cannot easily obtain the real gateway token from outside the
    // container, so we test the endpoint's validation behavior:
    // - Missing token => 401
    // - Invalid token => 401
    const noAuthRes = await fetch(
      `${process.env.PINCHY_URL || "http://localhost:7777"}/api/internal/audit/tool-use`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "end",
          toolName: "odoo_read",
          agentId,
          sessionKey: `agent:${agentId}:user-test`,
          params: { model: "sale.order" },
          durationMs: 42,
        }),
      }
    );
    expect(noAuthRes.status).toBe(401);

    const badAuthRes = await fetch(
      `${process.env.PINCHY_URL || "http://localhost:7777"}/api/internal/audit/tool-use`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: JSON.stringify({
          phase: "end",
          toolName: "odoo_read",
          agentId,
          sessionKey: `agent:${agentId}:user-test`,
          params: { model: "sale.order" },
          durationMs: 42,
        }),
      }
    );
    expect(badAuthRes.status).toBe(401);
  });
});

// ── Dispatch probe (pinchy-odoo plugin coverage) ─────────────────────────────
// Proves pinchy-odoo loaded correctly and registerTool() worked end-to-end.
// Switches the default provider to fake-Ollama for this describe block only,
// creates a disposable agent with odoo_list_models allowed, and asserts that the
// fake-LLM trigger results in an audit entry for tool.odoo_list_models.
test.describe("Odoo dispatch probe (pinchy-odoo plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    // 240 s (was 180 s): waitForOpenClawStable now also waits for
    // configPushesPending=0, whose worst case (a config.apply parked across
    // rate-limit windows before the file fallback settles it) adds up to
    // ~100 s before the 30 s stable streak can begin.
    testInfo.setTimeout(240_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Drain OC's config.apply rate-limit window. OC 5.3 allows ~3 calls per
    //    45 s per (device,IP) tuple. Tests 1–5 of this suite each trigger one
    //    regenerateOpenClawConfig() (PATCHes / setAgentPermissions cascades),
    //    so by the time this probe starts the rate-limit counter is at or near
    //    the cap. The second config.apply from this probe (after POST agent +
    //    PATCH allowedTools) then gets rejected with UNAVAILABLE, falls through
    //    to the inotify file-watcher fallback, and races a still-in-flight
    //    earlier config.apply that overwrites OC's in-memory state with stale
    //    content — leading to "unknown agent id" when the dispatch chat fires.
    //
    //    45 s wasn't enough: CI run 26038713754 showed
    //      "rate limit exceeded for config.apply; retry after 9s"
    //    AT the end of the 45 s drain, meaning OC's counter still had stale
    //    calls in the window. 60 s gives ~15 s slack past the rate-limit
    //    window so this probe's regens always land in a fully fresh window.
    await new Promise((r) => setTimeout(r, 60_000));

    // 3. Swap default_provider to ollama-local and seed ollama_local_url.
    //    Pinchy can reach ollama.local via the extra_hosts mapping added to the
    //    docker-compose.odoo-test.yml overlay. OpenClaw already has this mapping.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 4. Login (API cookie).
    dispatchCookie = await login();

    // 4. Create Odoo connection so the agent config includes the plugin block.
    const connRes = await createOdooConnection(dispatchCookie, "E2E Odoo Dispatch");
    expect(connRes.status).toBe(201);
    dispatchConnectionId = ((await connRes.json()) as { id: string }).id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Odoo Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    expect(createRes.status).toBe(201);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 5b. Seed the records each ref-based tool probe (pinchy#791) reads to mint a
    //     runtime `_pinchy_ref`. sale.order + crm.lead are already in the mock's
    //     defaults; the models below are empty/absent by default. resetOdooMock
    //     runs once in the outer describe's beforeAll (before this one), so these
    //     seeds persist for the whole probe block.
    //
    //     TWO mail.activity records on purpose: odoo_complete_activity finishes an
    //     activity via action_feedback, which the mock UNLINKS (mirroring Odoo).
    //     odoo_read returns the first remaining record, so complete consumes 9101
    //     and reschedule still has 9102 to read — the two activity probes never
    //     contend for the same row regardless of run order.
    await seedOdooRecords("mail.activity", [
      {
        id: 9101,
        summary: "E2E activity (complete target)",
        date_deadline: "2030-01-01",
        res_model_id: [5, "crm.lead"],
        res_id: 1,
        user_id: [7, "Sally Seller"],
      },
      {
        id: 9102,
        summary: "E2E activity (reschedule target)",
        date_deadline: "2030-01-01",
        res_model_id: [5, "crm.lead"],
        res_id: 1,
        user_id: [7, "Sally Seller"],
      },
    ]);
    await seedOdooRecords("stock.quant", [
      { id: 9201, name: "Quant DSM-2030", inventory_quantity: 12, quantity: 10 },
    ]);
    await seedOdooRecords("stock.picking", [
      { id: 9301, name: "WH/OUT/E2E-0001", state: "assigned" },
    ]);
    await seedOdooRecords("mrp.production", [
      { id: 9401, name: "MO/E2E-0001", state: "confirmed" },
    ]);
    await seedOdooRecords("purchase.order", [{ id: 9501, name: "P0E2E-01", state: "draft" }]);
    // Reconcile (payment counterpart): a POSTED bill with one open payable line,
    // plus a payment whose journal entry has a matching open line on the SAME
    // account. js_assign_outstanding_line (the mock handler added for this)
    // zeroes the bill's residual — the ONLY signal the plugin trusts to report
    // success (didReconcile), so this exercises the real verification path, not
    // a blind return value.
    await seedOdooRecords("account.move", [
      {
        id: 9601,
        name: "BILL/E2E-0001",
        state: "posted",
        payment_state: "not_paid",
        amount_residual: 119.0,
        company_id: [1, "Helmcraft GmbH"],
        partner_id: [1, "Müller GmbH"],
      },
    ]);
    await seedOdooRecords("account.payment", [
      {
        id: 9701,
        name: "PAY/E2E-0001",
        move_id: [9602, "PAY/E2E-0001"],
        state: "paid",
        company_id: [1, "Helmcraft GmbH"],
      },
    ]);
    // Duplicate guard (pinchy#721): a POSTED vendor bill already on file. A
    // second odoo_create with this same ref+move_type must be blocked; the
    // override probe re-files it deliberately. It carries no lines, so the
    // mock's amount-computation leaves it untouched. Crucially it is seeded
    // AFTER the reconcile bill (9601): the reconcile probe's odoo_read passes no
    // `order`, so the mock returns account.move in INSERTION order, keeping 9601
    // first and the probe's `refs[0]` on the reconcile bill. The id (9801 > 9601)
    // is a belt-and-suspenders in case a default id sort is ever introduced.
    // Do not reorder these seeds.
    await seedOdooRecords("account.move", [
      {
        id: 9801,
        name: "BILL/E2E-DUP",
        move_type: "in_invoice",
        state: "posted",
        ref: FAKE_OLLAMA_ODOO_DUP_BILL_REF,
        company_id: [1, "Helmcraft GmbH"],
        partner_id: [1, "Müller GmbH"],
      },
    ]);
    await seedOdooRecords("account.move.line", [
      {
        id: 9611,
        move_id: [9601, "BILL/E2E-0001"],
        account_id: [50, "Kundenforderungen"],
        account_type: "asset_receivable",
        reconciled: false,
        debit: 119.0,
        credit: 0,
      },
      {
        id: 9612,
        move_id: [9602, "PAY/E2E-0001"],
        account_id: [50, "Kundenforderungen"],
        account_type: "asset_receivable",
        reconciled: false,
        debit: 0,
        credit: 119.0,
      },
    ]);

    // 6. Grant Odoo permissions → triggers regenerateOpenClawConfig() which now
    //    reads default_provider=ollama-local and emits the Ollama provider block.
    //    Each ref-based tool (pinchy#791) needs read on its ref model (to mint
    //    the ref via odoo_read) plus the write/create its handler checks. One
    //    setAgentPermissions call = one regen, so listing every pair here does
    //    not add to the config.apply rate-limit pressure the drain above guards.
    //    res.partner is deliberately NOT granted so the failure probe below still
    //    hits permissionDenied on odoo_read res.partner.
    await setAgentPermissions(dispatchCookie, dispatchAgentId, dispatchConnectionId, [
      { model: "sale.order", operation: "read" },
      { model: "sale.order", operation: "write" },
      { model: "crm.lead", operation: "read" },
      { model: "mail.activity", operation: "create" },
      { model: "mail.activity", operation: "read" },
      { model: "mail.activity", operation: "write" },
      { model: "stock.quant", operation: "read" },
      { model: "stock.quant", operation: "write" },
      { model: "stock.picking", operation: "read" },
      { model: "stock.picking", operation: "write" },
      { model: "mrp.production", operation: "read" },
      { model: "mrp.production", operation: "write" },
      { model: "purchase.order", operation: "read" },
      { model: "purchase.order", operation: "write" },
      { model: "account.move", operation: "read" },
      { model: "account.move", operation: "create" },
      { model: "account.move.line", operation: "write" },
      { model: "account.payment", operation: "read" },
      { model: "ir.attachment", operation: "create" },
    ]);

    // 7. Allow odoo_list_models (happy-path probe), odoo_read (failure probe +
    //    the read half of every ref-dispatch chain), and each ref-based tool
    //    under test (pinchy#791).
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      {
        allowedTools: [
          "odoo_list_models",
          "odoo_read",
          "odoo_schedule_activity",
          "odoo_complete_activity",
          "odoo_reschedule_activity",
          "odoo_confirm_order",
          "odoo_apply_inventory",
          "odoo_validate_picking",
          "odoo_mark_mo_done",
          "odoo_set_approval",
          "odoo_reconcile",
          "odoo_attach_file",
          "odoo_create",
        ],
      },
      dispatchCookie
    );
    expect(patchRes.status).toBe(200);

    // 8. Wait for OpenClaw to stabilise with the new Ollama config.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", dispatchCookie));

    // 9. Wait until OC's runtime actually has THIS agent in `agents.list`.
    // Stability alone doesn't prove dispatchability: the regens from steps
    // 6 + 7 are fire-and-forget, and if Pinchy's earlier tests in the
    // suite exhausted OC's config.apply rate-limit window the probe's
    // regens fall through to the inotify file-watcher fallback whose
    // debounce can stretch past the stability check. Polling OC's actual
    // agents.list view via the health endpoint closes that race window
    // — see CI run 26505503327 for the prior "unknown agent id" failure
    // mode this guards against.
    await waitForAgentDispatchable(
      (agentId) => pinchyGet(`/api/health/openclaw?agentId=${agentId}`, dispatchCookie),
      dispatchAgentId
    );
  });

  test.afterAll(async () => {
    if (dispatchAgentId) {
      await pinchyDelete(`/api/agents/${dispatchAgentId}`, dispatchCookie);
    }
    if (dispatchConnectionId) {
      await pinchyDelete(`/api/integrations/${dispatchConnectionId}`, dispatchCookie);
    }
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test("odoo_list_models dispatches via fake-LLM and writes audit entry", async ({
    page,
  }, testInfo) => {
    // The chat path's chatWithDispatchRaceRetry retries `unknown agent id` for
    // up to 150 s while OC's runtime catches up to a freshly-created agent
    // (measured: a coalesced file-watcher reload landed ~104 s after dispatch).
    // The audit lands shortly after the dispatch succeeds, so the poll must
    // outlast the retry budget, and the per-test timeout must outlast the poll
    // + login + nav. Default Playwright 120 s would cut this off mid-poll.
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_ODOO_LIST_MODELS_TOOL_TRIGGER}: list Odoo models`);
    await input.press("Enter");

    // 160 s deadline: just past chatWithDispatchRaceRetry's 150 s budget so the
    // poll is still running when a late dispatch finally writes its audit. No
    // chat re-send (the earlier probe's aggressive re-send measurably worsened
    // this flake — re-sending chat doesn't trigger an agents reload and floods
    // OC with agent RPCs; CI run 26843343975).
    const found = await pollAuditForTool(page, {
      toolName: "odoo_list_models",
      agentId: dispatchAgentId,
      deadlineMs: 160_000,
    });
    expect(found).toBe(true);
  });

  test("a failed odoo tool is audited as outcome=failure, not false-success", async ({
    page,
  }, testInfo) => {
    // Regression guard for the 2026-06-25 false-success incident: a failed
    // odoo tool call (here permissionDenied) must land in the audit log as
    // outcome=failure. The plugin returns { isError, details: { error } };
    // OpenClaw strips isError (#404), so the audit endpoint relies on the
    // plugin-supplied details.error to record the failure. Before the fix this
    // exact row was recorded as outcome=success with a green checkmark.
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    // Capture the cutoff BEFORE dispatch so the poll cannot match a stale row.
    const since = new Date().toISOString();

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_ODOO_READ_DENIED_TRIGGER}: read partners`);
    await input.press("Enter");

    // Poll for a FAILURE-outcome row specifically (status=failure). pollAuditForTool
    // only proves an entry exists; here the outcome is the whole point.
    const deadline = Date.now() + 160_000;
    let foundFailure = false;
    while (Date.now() < deadline) {
      const res = await page.request.get(
        `/api/audit?eventType=tool.odoo_read&status=failure&from=${encodeURIComponent(
          since
        )}&limit=10`
      );
      if (res.status() === 200) {
        const audit = (await res.json()) as {
          entries: Array<{ resource: string | null }>;
        };
        if (audit.entries.some((entry) => entry.resource === `agent:${dispatchAgentId}`)) {
          foundFailure = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(foundFailure).toBe(true);
  });

  test("a ref-based tool (odoo_schedule_activity) dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    // pinchy#791: ref-based odoo tools take an opaque `_pinchy_ref` minted at
    // runtime, so a static tool_call can never carry a valid one. The fake-LLM
    // resolves it dynamically — round 1 dispatches odoo_read on crm.lead, then
    // reads the real `_pinchy_ref` back out of that tool result and reuses it in
    // odoo_schedule_activity (round 2). This proves the whole ref chain runs
    // end-to-end against the real plugin + Odoo mock, not just the read half.
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    // Capture the cutoff BEFORE dispatch so the poll cannot match a stale row.
    const since = new Date().toISOString();

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(
      `${FAKE_OLLAMA_ODOO_SCHEDULE_ACTIVITY_REF_TRIGGER}: schedule a follow-up on a lead`
    );
    await input.press("Enter");

    // Assert the SECOND-round tool (the ref-based one) not only dispatched but
    // SUCCEEDED. outcome=success is the whole point: it proves the runtime
    // `_pinchy_ref` decoded, the crm.lead target was read, and mail.activity was
    // created — the full ref chain end-to-end. A broken ref would still dispatch
    // (audited outcome=failure), so a dispatch-only assertion could false-pass.
    const entry = await pollAuditForEvent(page, {
      eventType: "tool.odoo_schedule_activity",
      predicate: (e) => e.resource === `agent:${dispatchAgentId}`,
      since,
      deadlineMs: 160_000,
    });
    expect(entry.outcome).toBe("success");
  });

  // ── Remaining ref-based tools (pinchy#791) ────────────────────────────────
  // Every tool below takes an opaque runtime-minted `_pinchy_ref`. The fake-LLM
  // resolves it dynamically (round 1 odoo_read on the ref model → round 2 reuse
  // the returned ref in the tool), exactly like the schedule_activity probe
  // above. Each asserts outcome=success, not merely that a row exists: a broken
  // ref still dispatches (audited failure), so dispatch-only could false-pass.
  //
  // These share the one warm OpenClaw session created in beforeAll, so unlike
  // the first probe they do not pay the cold-start dispatch-race budget.
  async function runRefDispatchProbe(
    page: Page,
    testInfo: TestInfo,
    opts: {
      trigger: string;
      eventType: string;
      message: string;
      // Optional setup run after the composer is ready but before the cutoff is
      // captured and the trigger fires — e.g. odoo_attach_file uploads its
      // fixture here so the file exists in the agent's uploads/ dir on disk.
      beforeDispatch?: (page: Page) => Promise<void>;
    }
  ): Promise<void> {
    testInfo.setTimeout(180_000);
    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });

    if (opts.beforeDispatch) await opts.beforeDispatch(page);

    // Capture the cutoff BEFORE dispatch so the poll cannot match a stale row.
    const since = new Date().toISOString();
    await input.fill(`${opts.trigger}: ${opts.message}`);
    await input.press("Enter");

    const entry = await pollAuditForEvent(page, {
      eventType: opts.eventType,
      predicate: (e) => e.resource === `agent:${dispatchAgentId}`,
      since,
      deadlineMs: 160_000,
    });
    // Surface the audited failure reason on assertion failure — a ref tool that
    // dispatches but the plugin rejects (bad ref, missing seed, silent no-op)
    // audits outcome=failure with the plugin's error in `detail`. Printing it
    // makes a red probe self-diagnose in the CI log instead of just "failure".
    expect(entry.outcome, `audit detail: ${JSON.stringify(entry.detail)}`).toBe("success");
  }

  test("odoo_complete_activity dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_COMPLETE_ACTIVITY_REF_TRIGGER,
      eventType: "tool.odoo_complete_activity",
      message: "mark the activity done",
    });
  });

  test("odoo_reschedule_activity dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_RESCHEDULE_ACTIVITY_REF_TRIGGER,
      eventType: "tool.odoo_reschedule_activity",
      message: "push the follow-up to a new date",
    });
  });

  test("odoo_confirm_order dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_CONFIRM_ORDER_REF_TRIGGER,
      eventType: "tool.odoo_confirm_order",
      message: "confirm the quotation",
    });
  });

  test("odoo_apply_inventory dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_APPLY_INVENTORY_REF_TRIGGER,
      eventType: "tool.odoo_apply_inventory",
      message: "apply the inventory count",
    });
  });

  test("odoo_validate_picking dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_VALIDATE_PICKING_REF_TRIGGER,
      eventType: "tool.odoo_validate_picking",
      message: "validate the transfer",
    });
  });

  test("odoo_mark_mo_done dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_MARK_MO_DONE_REF_TRIGGER,
      eventType: "tool.odoo_mark_mo_done",
      message: "mark the manufacturing order done",
    });
  });

  test("odoo_set_approval dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_SET_APPROVAL_REF_TRIGGER,
      eventType: "tool.odoo_set_approval",
      message: "approve the purchase order",
    });
  });

  test("odoo_reconcile dispatches on runtime-minted invoice + counterpart refs", async ({
    page,
  }, testInfo) => {
    // The only two-ref tool: round 1 reads account.move (invoice ref), round 2
    // reads account.payment (counterpart ref), round 3 reconciles on both. The
    // mock's js_assign_outstanding_line zeroes the bill's residual, which is the
    // only thing the plugin trusts (didReconcile) — so outcome=success proves
    // the whole payment-counterpart path, not a blind method return.
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_RECONCILE_REF_TRIGGER,
      eventType: "tool.odoo_reconcile",
      message: "reconcile the bill against the payment",
    });
  });

  test("odoo_attach_file dispatches on a runtime-minted _pinchy_ref", async ({
    page,
  }, testInfo) => {
    // odoo_attach_file reads a file from the agent's uploads/ dir on disk, so
    // this probe FIRST uploads that file through the composer (landing it under
    // the exact basename the fake-LLM will pass) via beforeDispatch, then fires
    // the trigger. Round 1 reads sale.order (target ref), round 2 attaches
    // `test.pdf` to it.
    await runRefDispatchProbe(page, testInfo, {
      trigger: FAKE_OLLAMA_ODOO_ATTACH_FILE_REF_TRIGGER,
      eventType: "tool.odoo_attach_file",
      message: "attach the document to the order",
      beforeDispatch: async (page) => {
        // Upload the fixture the fake-LLM will attach (basename must match the
        // filename in the odoo_attach_file probe's buildArgs).
        const fixturesDir = path.join(__dirname, "../fixtures");
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          page.locator(".aui-composer-add-attachment").click(),
        ]);
        await fileChooser.setFiles(
          path.join(fixturesDir, FAKE_OLLAMA_ODOO_ATTACH_FILE_REF_FILENAME)
        );

        // Wait until the upload chip reaches "ready" (POST /uploads returned 200
        // → the file now exists in the agent's uploads/ dir for the plugin to
        // read).
        const readyChip = page
          .locator(".text-green-600")
          .locator("xpath=ancestor::*[@class and contains(@class,'rounded-lg')]")
          .first();
        await expect(readyChip).toBeVisible({ timeout: 20_000 });
      },
    });
  });

  // ── Deterministic vendor-bill duplicate guard (pinchy#721) ────────────────
  // A vendor bill with ref ODOO_DUP_BILL_REF is already on file (seeded in
  // beforeAll). These two probes dispatch odoo_create for the SAME ref and
  // assert the AUDIT outcome end-to-end: a blind create is BLOCKED (failure),
  // and the explicit allow_duplicate:true override proceeds (success). This is
  // the audit half of the acceptance — the block/override logic itself is unit-
  // and integration-tested against the same odoo-mock.
  async function dispatchCreateAndGetAudit(page: Page, testInfo: TestInfo, trigger: string) {
    testInfo.setTimeout(180_000);
    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });

    const since = new Date().toISOString();
    await input.fill(`${trigger}: file the vendor bill`);
    await input.press("Enter");

    return pollAuditForEvent(page, {
      eventType: "tool.odoo_create",
      predicate: (e) => e.resource === `agent:${dispatchAgentId}`,
      since,
      deadlineMs: 160_000,
    });
  }

  test("odoo_create is BLOCKED for a duplicate vendor bill (audited failure)", async ({
    page,
  }, testInfo) => {
    const entry = await dispatchCreateAndGetAudit(
      page,
      testInfo,
      FAKE_OLLAMA_ODOO_CREATE_DUP_BLOCK_TRIGGER
    );
    expect(entry.outcome, `audit detail: ${JSON.stringify(entry.detail)}`).toBe("failure");
    // The blocked attempt is what the audit trail should show — with the
    // structured refusal (naming the on-file bill) in the detail.
    expect(JSON.stringify(entry.detail)).toContain("blocked");
  });

  test("odoo_create PROCEEDS for a duplicate when allow_duplicate is set (audited success)", async ({
    page,
  }, testInfo) => {
    const entry = await dispatchCreateAndGetAudit(
      page,
      testInfo,
      FAKE_OLLAMA_ODOO_CREATE_DUP_OVERRIDE_TRIGGER
    );
    expect(entry.outcome, `audit detail: ${JSON.stringify(entry.detail)}`).toBe("success");
    // The deliberate override is traceable: the curated detail flags it.
    expect(JSON.stringify(entry.detail)).toContain("duplicateOverride");
  });
});
