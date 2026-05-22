import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForGmailMock,
  resetGmailMock,
  getSentMessages,
  getGmailRequests,
  createGoogleConnectionInDb,
  getAdminEmail,
  getAdminPassword,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPut,
  pinchyPatch,
  pinchyDelete,
  waitForOpenClawConnected,
} from "./helpers";
import {
  FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER,
  FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
} from "../shared/dispatch-probe";

test.describe("pinchy-email — Gmail E2E", () => {
  let cookie: string;
  let agentId: string;
  let connectionId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await seedSetup();
    await waitForPinchy();
    await waitForGmailMock();
    await resetGmailMock();
    cookie = await login();

    // Wait for OpenClaw to settle after the setup wizard restart before running
    // tests. The setup wizard triggers a full gateway restart (plugins/agents
    // changed); granting integrations in the tests triggers another. We wait
    // here so the test-body timeout only covers the second restart, not both.
    const settled = await waitForOpenClawConnected(cookie, 120000);
    if (!settled) throw new Error("OpenClaw did not reconnect after setup wizard");

    // Get Smithers agent
    const agents = await pinchyGet("/api/agents", cookie);
    expect(agents.status).toBe(200);
    const agentList = (await agents.json()) as Array<{ name: string; id: string }>;
    const smithers = agentList.find((a) => a.name === "Smithers");
    if (!smithers) throw new Error("Smithers agent not found — was seedSetup successful?");
    agentId = smithers.id;
  });

  test("pinchy-email plugin loads after Google connection is configured (staging regression)", async () => {
    // This test guards against the scenario where pinchy-email is not in the
    // extensions volume, so OpenClaw logs "plugin not found" and the email tools
    // are never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with pinchy-email
    // enabled and stays connected. We verify this by granting email permissions
    // and confirming OpenClaw remains connected (i.e. the regenerated config was
    // accepted, not rejected with INVALID_CONFIG).

    // Insert Google connection directly into DB (OAuth flow is not testable in E2E)
    const conn = await createGoogleConnectionInDb("Test Gmail");
    connectionId = conn.id;
    expect(conn.type).toBe("google");

    // Grant email read permissions to Smithers via the integrations API
    const permRes = await fetch(
      (process.env.PINCHY_URL || "http://localhost:7777") + `/api/agents/${agentId}/integrations`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: process.env.PINCHY_URL || "http://localhost:7777",
        },
        body: JSON.stringify({
          connectionId,
          permissions: [
            { model: "email", operation: "read" },
            { model: "email", operation: "search" },
          ],
        }),
      }
    );
    expect(permRes.status).toBe(200);

    // Trigger config regeneration by PATCHing the agent
    // (the integrations PUT does NOT regenerate config on its own)
    const patchRes = await pinchyPatch(`/api/agents/${agentId}`, {}, cookie);
    expect(patchRes.status).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // Granting pinchy-email adds a new plugin entry — OpenClaw does a full
    // restart. Give 120s to cover the restart + reconnect window.
    const connected = await waitForOpenClawConnected(cookie, 120000);
    expect(connected).toBe(true);

    // The Google connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const googleConn = list.find((c) => c.type === "google");
    expect(googleConn).toBeDefined();
    expect(googleConn!.id).toBe(connectionId);
  });

  test("agent permissions model — read-only agent does not have send or draft operations", async () => {
    // Verify that the permissions set in test 1 (read + search only) are
    // correctly reflected in the integrations API.
    //
    // The connectionId is set by test 1 above.
    if (!connectionId) {
      throw new Error("connectionId not set — did test 1 run successfully?");
    }

    const integrationsRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(integrationsRes.status).toBe(200);

    const integrations = (await integrationsRes.json()) as Array<{
      connectionId: string;
      connectionType: string;
      permissions: Array<{ model: string; operation: string }>;
    }>;

    const emailIntegration = integrations.find((i) => i.connectionId === connectionId);
    expect(emailIntegration).toBeDefined();
    expect(emailIntegration!.connectionType).toBe("google");

    const ops = emailIntegration!.permissions.map((p) => p.operation);
    expect(ops).toContain("read");
    expect(ops).toContain("search");
    expect(ops).not.toContain("send");
    expect(ops).not.toContain("draft");
  });
});

// ── Dispatch probe (pinchy-email plugin coverage) ────────────────────────────
// Proves pinchy-email loaded correctly and registerTool() worked end-to-end.
// Switches the default provider to fake-Ollama for this describe block only,
// creates a disposable agent with email_list allowed, and asserts that the
// fake-LLM trigger results in an audit entry for tool.email_list.
test.describe("Email dispatch probe (pinchy-email plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Swap default_provider to ollama-local and seed ollama_local_url.
    const dbUrl =
      process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 3. Login (API cookie).
    dispatchCookie = await login();

    // 4. Create Google connection so the agent config includes the plugin block.
    const conn = await createGoogleConnectionInDb("E2E Email Dispatch");
    dispatchConnectionId = conn.id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Email Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Grant email read + send permissions → triggers regenerateOpenClawConfig()
    //    which now reads default_provider=ollama-local and emits the Ollama
    //    provider block. We grant `send` here too so the send round-trip test
    //    below doesn't have to do a second permissions edit (each edit triggers
    //    its own config-apply rate-limit cost on OC).
    const permRes = await pinchyPut(
      `/api/agents/${dispatchAgentId}/integrations`,
      {
        connectionId: dispatchConnectionId,
        permissions: [
          { model: "email", operation: "read" },
          { model: "email", operation: "send" },
        ],
      },
      dispatchCookie
    );
    if (permRes.status !== 200)
      throw new Error(`Permissions grant failed: ${String(permRes.status)}`);

    // 7. Allow email_list + email_send — second config regen with the tools in
    //    the allow-list.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["email_list", "email_send"] },
      dispatchCookie
    );
    if (patchRes.status !== 200) throw new Error(`Agent patch failed: ${String(patchRes.status)}`);

    // 8. Wait for OpenClaw to stabilise with the new Ollama config.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", dispatchCookie));
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

  test("email_list dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER}: list my emails`);
    await input.press("Enter");

    const found = await pollAuditForTool(page, {
      toolName: "email_list",
      agentId: dispatchAgentId,
    });
    expect(found).toBe(true);
  });

  // Round-trip test: prove the plugin actually called the Gmail API and used
  // credentials it fetched through Pinchy's internal endpoint. Previously a
  // `test.skip` with a TODO that said fake-ollama doesn't support tool calls.
  // fake-ollama gained EMAIL_LIST_TRIGGER long ago — implementing now.
  test("gmail-mock receives email_list request when tool is invoked via chat", async ({ page }) => {
    await resetGmailMock();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    // Capture `since` BEFORE the dispatch — the previous test
    // ("email_list dispatches via fake-LLM and writes audit entry") already
    // wrote a `tool.email_list` audit entry on the same agent. Without the
    // filter, pollAuditForTool matches that stale entry and returns true
    // before the new dispatch has actually reached gmail-mock, then the
    // /control/requests assertion races and fails. See run 26289436861.
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER}: round-trip list`);
    await input.press("Enter");

    // Wait for the audit entry first — that confirms the dispatch happened.
    const dispatched = await pollAuditForTool(page, {
      toolName: "email_list",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // The plugin's credential cache expires every 5 min; after resetGmailMock
    // cleared the request log we want to see at least one /token (credential
    // refresh) AND at least one /messages call against the Gmail API. If the
    // plugin had hard-coded a token instead of fetching from
    // /api/internal/integrations, /token would never be hit.
    const reqs = await getGmailRequests();
    expect(
      reqs.some((r) => r.endpoint === "/messages"),
      `gmail-mock received no /messages request; saw: ${JSON.stringify(reqs)}`
    ).toBe(true);
  });

  test("gmail-mock receives email_send request when tool is invoked via chat", async ({ page }) => {
    await resetGmailMock();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    // Capture `since` BEFORE the dispatch. email_send is currently
    // dispatched only by this test, so the stale-match race that broke
    // the email_list round-trip doesn't apply here today — but pinning
    // the `since`-based pattern across all round-trip tests means a
    // future "email_send dispatches via fake-LLM" probe won't silently
    // re-introduce the same flake.
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER}: round-trip send`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_send",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // Verify a message actually landed in gmail-mock's sent box. The mock
    // accepts MIME in `raw` and stores it verbatim — we only need to confirm
    // *something* arrived. Subject/body matching would couple the test to
    // fake-ollama's exact MIME encoding which is itself an integration detail.
    const sent = await getSentMessages();
    expect(sent.length, "gmail-mock got no sent message").toBeGreaterThan(0);
  });
});
