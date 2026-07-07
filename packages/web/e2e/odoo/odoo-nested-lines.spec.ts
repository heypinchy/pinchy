import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  login,
  createOdooConnection,
  setAgentPermissions,
  getAdminEmail,
  getAdminPassword,
  pinchyGet,
  pinchyPatch,
  pinchyPost,
  pinchyDelete,
  getOdooRecords,
} from "./helpers";
import {
  FAKE_OLLAMA_ODOO_CREATE_NESTED_LINES_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../shared/dispatch-probe";
import { stackDbUrl } from "../shared/stack-db";

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

// ── Nested one2many many2one resolution (#615) ──────────────────────────────
// Proves the open question from issue #615: when odoo_create writes a
// one2many line whose nested many2one field (account.move.line#account_id)
// is ambiguous across companies ("Bank" exists as both id 40 and id 41 in
// the mock — see config/odoo-mock/server.js), the plugin must resolve it
// scoped to the PARENT record's company before dispatch. The mock now
// rejects any many2one write value that reaches it as a bare string (real
// Odoo's own behavior), so a SUCCESS audit row here is not a false-success —
// it's proof the plugin resolved "Bank" to an id before the create ever left
// the process.
test.describe("Odoo nested one2many many2one resolution (#615)", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    // Mirrors the dispatch-probe timeout budget in odoo-agent-chat.spec.ts:
    // config.apply rate-limit drain (60 s) + waitForOpenClawStable's worst
    // case (~100 s more) can approach 200 s before this hook even reaches the
    // per-test dispatch step.
    testInfo.setTimeout(240_000);

    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();

    // 1. Start fake-Ollama on the host.
    await startFakeOllama();

    // 2. Drain OC's config.apply rate-limit window (see odoo-agent-chat.spec.ts
    //    for the full rationale — ~3 calls per 45 s per (device,IP) tuple).
    await new Promise((r) => setTimeout(r, 60_000));

    // 3. Swap default_provider to ollama-local and seed ollama_local_url.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 4. Login (API cookie).
    cookie = await login();

    const ocConnected = await pollUntilOpenClawConnected(cookie, 60_000);
    if (!ocConnected) {
      throw new Error("OpenClaw WS bridge not connected after 60 s — aborting test suite");
    }

    // 5. Create Odoo connection so the agent config includes the plugin block.
    const connRes = await createOdooConnection(cookie, "E2E Odoo Nested Lines");
    expect(connRes.status).toBe(201);
    connectionId = ((await connRes.json()) as { id: string }).id;

    // 6. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Odoo Nested Lines Probe", templateId: "custom" },
      cookie
    );
    expect(createRes.status).toBe(201);
    agentId = ((await createRes.json()) as { id: string }).id;

    // 7. Grant `create` on account.move (the trigger's target model) plus the
    //    read permissions the plugin's m2o/company resolution needs while
    //    normalizing the create payload (journal_id, company_id, account_id
    //    lookups all go through odoo_read-equivalent searchRead calls).
    await setAgentPermissions(cookie, agentId, connectionId, [
      { model: "account.move", operation: "create" },
      { model: "account.move", operation: "read" },
      { model: "account.journal", operation: "read" },
      { model: "res.company", operation: "read" },
      { model: "account.account", operation: "read" },
    ]);

    // 8. Allow odoo_create.
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: ["odoo_create"] },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // 9. Wait for OpenClaw to stabilise with the new config.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));

    // 10. Wait until OC's runtime actually has this agent in `agents.list`.
    await waitForAgentDispatchable(
      (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
      agentId
    );
  });

  test.afterAll(async () => {
    if (agentId) {
      await pinchyDelete(`/api/agents/${agentId}`, cookie);
    }
    if (connectionId) {
      await pinchyDelete(`/api/integrations/${connectionId}`, cookie);
    }
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test("odoo_create resolves a nested one2many account_id company-scoped and succeeds", async ({
    page,
  }, testInfo) => {
    // Mirrors odoo-agent-chat.spec.ts's dispatch probe timeout rationale:
    // chatWithDispatchRaceRetry retries `unknown agent id` for up to 150 s.
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_ODOO_CREATE_NESTED_LINES_TRIGGER}: book the opening entry`);
    await input.press("Enter");

    // 160 s deadline: just past chatWithDispatchRaceRetry's 150 s budget so the
    // poll is still running when a late dispatch finally writes its audit. No
    // chat re-send — see odoo-agent-chat.spec.ts for why re-sending worsens
    // this flake.
    const found = await pollAuditForTool(page, {
      toolName: "odoo_create",
      agentId,
      deadlineMs: 160_000,
    });
    expect(found).toBe(true);

    // Proof beyond the audit row: assert directly against the mock that the
    // move was created with two lines, and each line's account_id resolved
    // to the COMPANY-1 "Bank" account (id 40), not company-2's "Bank" (id
    // 41). Only company scoping of the nested many2one lookup gets this
    // right — a name-only lookup would either be rejected as ambiguous or
    // (pre-#627) reach the mock as an unresolved string and be rejected by
    // the many2one write-value validation added for this issue.
    const moves = await getOdooRecords("account.move");
    expect(moves.length).toBeGreaterThan(0);
    const move = moves[moves.length - 1] as { line_ids?: number[] };
    expect(Array.isArray(move.line_ids)).toBe(true);
    expect(move.line_ids).toHaveLength(2);

    const lines = await getOdooRecords("account.move.line");
    const createdLines = lines.filter((line) =>
      (move.line_ids as number[]).includes(line.id as number)
    );
    expect(createdLines).toHaveLength(2);
    for (const line of createdLines) {
      expect(line.account_id).toBe(40);
    }
  });
});
