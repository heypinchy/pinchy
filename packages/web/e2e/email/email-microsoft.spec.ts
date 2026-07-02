import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForGraphMock,
  resetGraphMock,
  seedGraphMockMessages,
  getGraphMockRequests,
  createMicrosoftConnectionInDb,
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
  FAKE_OLLAMA_EMAIL_SEARCH_TOOL_TRIGGER,
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
import { stackDbUrl } from "../shared/stack-db";

test.describe("pinchy-email — Microsoft E2E", () => {
  let cookie: string;
  let agentId: string;
  let connectionId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await seedSetup();
    await waitForPinchy();
    await waitForGraphMock();
    await resetGraphMock();
    cookie = await login();

    // Get Smithers agent ID early — /api/agents is a DB query and does not
    // require OC to be connected. We need the ID before the DELETE below.
    const agents = await pinchyGet("/api/agents", cookie);
    expect(agents.status).toBe(200);
    const agentList = (await agents.json()) as Array<{ name: string; id: string }>;
    const smithers = agentList.find((a) => a.name === "Smithers");
    if (!smithers) throw new Error("Smithers agent not found — was seedSetup successful?");
    agentId = smithers.id;

    // Clear any pre-existing email integrations for Smithers (e.g. left behind
    // by the Gmail E2E spec that runs in the same job). Done here — before the
    // rate-limit sleep — so the resulting regenerateOpenClawConfig call is
    // covered by the 35s wait below. If this DELETE were inside test 1, the
    // subsequent permission grant would fire a config.apply within the 25s
    // rate-limit window and hot-reload would fall back to 60s inotify.
    await fetch(
      (process.env.PINCHY_URL || "http://localhost:7777") + `/api/agents/${agentId}/integrations`,
      {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: process.env.PINCHY_URL || "http://localhost:7777",
        },
      }
    );

    // Wait for OpenClaw to settle after the setup wizard restart and the DELETE
    // above (which may trigger a full gateway restart if Gmail permissions were
    // present). Both restarts are covered by this single wait.
    const settled = await waitForOpenClawConnected(cookie, 120000);
    if (!settled) throw new Error("OpenClaw did not reconnect after setup wizard");

    // Allow the config.apply rate-limit window to clear (~25s). This covers
    // seedSetup's calls AND the DELETE above. The next config.apply from test 1's
    // permission grant must fire cleanly — a rate-limited grant falls back to 60s
    // inotify, too slow for the chat tests.
    await new Promise((r) => setTimeout(r, 35000));
  });

  test("pinchy-email plugin loads after Microsoft connection is configured (staging regression)", async () => {
    // This test guards against the scenario where pinchy-email is not in the
    // extensions volume, so OpenClaw logs "plugin not found" and the email tools
    // are never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with pinchy-email
    // enabled and stays connected. We verify this by granting email permissions
    // and confirming OpenClaw remains connected (i.e. the regenerated config was
    // accepted, not rejected with INVALID_CONFIG).

    // Insert Microsoft connection directly into DB (OAuth flow is not testable in E2E)
    const conn = await createMicrosoftConnectionInDb("Test Microsoft");
    connectionId = conn.id;
    expect(conn.type).toBe("microsoft");

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
          // Exactly the shape the permission UI writes: read/draft/send only.
          // "search" is NOT an operation of its own (it is part of "read" —
          // see EMAIL_OPERATIONS in tool-registry.ts). Seeding a phantom
          // "search" row here previously masked a real bug where build.ts
          // required it and silently stripped email_search from every
          // UI-configured agent.
          permissions: [{ model: "email", operation: "read" }],
        }),
      }
    );
    expect(permRes.status).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // Granting pinchy-email adds a new plugin entry — OpenClaw does a full
    // restart. Give 120s to cover the restart + reconnect window.
    const connected = await waitForOpenClawConnected(cookie, 120000);
    expect(connected).toBe(true);

    // The Microsoft connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const microsoftConn = list.find((c) => c.type === "microsoft");
    expect(microsoftConn).toBeDefined();
    expect(microsoftConn!.id).toBe(connectionId);
  });

  test("agent permissions model — read-only agent does not have send or draft operations", async () => {
    // Verify that the permissions set in test 1 (read only — the exact shape
    // the UI writes) are correctly reflected in the integrations API.
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
    expect(emailIntegration!.connectionType).toBe("microsoft");

    const ops = emailIntegration!.permissions.map((p) => p.operation);
    expect(ops).toEqual(["read"]);
    expect(ops).not.toContain("send");
    expect(ops).not.toContain("draft");
  });
});

// ── Dispatch probe (pinchy-email plugin coverage, Microsoft) ─────────────────
// Mirrors the Gmail dispatch probe: switches the default provider to host
// fake-Ollama for this describe block only (via the allowed `ollama.local`
// alias), creates a disposable agent with a Microsoft connection and the email
// tools allowed, and asserts the fake-LLM trigger drives a real Graph API call.
test.describe("Microsoft email dispatch probe (pinchy-email plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Swap default_provider to ollama-local and seed ollama_local_url
    //    (points at host fake-Ollama via the allowed `ollama.local` alias).
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 3. Login (API cookie).
    dispatchCookie = await login();

    // 4. Create Microsoft connection so the agent config includes the plugin block.
    const conn = await createMicrosoftConnectionInDb("E2E Microsoft Dispatch");
    dispatchConnectionId = conn.id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Microsoft Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Grant email read + send permissions → triggers regenerateOpenClawConfig().
    //    Grant `send` here too so the send round-trip test below doesn't have to
    //    do a second permissions edit (each edit costs a config-apply rate-limit).
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

    // 7. Allow email_list + email_search + email_send — second config regen
    //    with the tools in the allow-list. email_search is deliberately backed
    //    ONLY by the "read" permission granted above (no "search" row exists in
    //    UI-written data) — the search dispatch test below proves that grant
    //    shape is sufficient end-to-end.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["email_list", "email_search", "email_send"] },
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

  test("email_list dispatches via fake-LLM and writes audit entry", async ({ page }, testInfo) => {
    // 160 s poll past the 150 s chatWithDispatchRaceRetry budget; 180 s per-test
    // timeout to outlast it.
    testInfo.setTimeout(180_000);

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
      deadlineMs: 160_000,
    });
    expect(found).toBe(true);
  });

  // Round-trip test: prove the plugin actually called the Microsoft Graph API
  // using credentials it fetched through Pinchy's internal endpoint.
  test("graph-mock receives email_list request when tool is invoked via chat", async ({ page }) => {
    await resetGraphMock();
    await seedGraphMockMessages([
      {
        subject: "Test email from graph-mock",
        from: "sender@example.com",
        body: "Hello from Microsoft E2E test",
        isRead: false,
      },
    ]);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    // Capture `since` BEFORE the dispatch — the previous test already wrote a
    // tool.email_list audit entry on the same agent; without the filter
    // pollAuditForTool matches that stale entry and the request assertion races.
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER}: round-trip list`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_list",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // The plugin must have called the Graph messages endpoint.
    const reqs = (await getGraphMockRequests()) as Array<{ endpoint: string }>;
    expect(
      reqs.some(
        (r) => r.endpoint === "/v1.0/me/messages" || r.endpoint?.startsWith("/v1.0/me/mailFolders/")
      ),
      `graph-mock received no messages request; saw: ${JSON.stringify(reqs)}`
    ).toBe(true);
  });

  // Regression guard for the bug fixed in f62f50045: the agent above holds
  // ONLY the read/send permission rows the UI actually writes — no "search"
  // row exists. email_search must still dispatch, because search is part of
  // "read" (build.ts derives the plugin tools via getEmailToolsForOperations,
  // and the plugin gates email_search behind the "read" permission). Before
  // the fix this dispatch was impossible for every UI-configured agent, and
  // the old seeds masked it by writing a phantom "search" row.
  test("email_search dispatches with only a read grant (no 'search' permission row)", async ({
    page,
  }) => {
    await resetGraphMock();
    await seedGraphMockMessages([
      {
        subject: "Searchable message",
        from: "sender@example.com",
        body: "Findable by the search probe",
        isRead: true,
      },
    ]);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_SEARCH_TOOL_TRIGGER}: find mail from sender`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_search",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // The plugin must have queried the Graph messages endpoint for the search.
    const reqs = (await getGraphMockRequests()) as Array<{ endpoint: string }>;
    expect(
      reqs.some(
        (r) => r.endpoint === "/v1.0/me/messages" || r.endpoint?.startsWith("/v1.0/me/mailFolders/")
      ),
      `graph-mock received no search request; saw: ${JSON.stringify(reqs)}`
    ).toBe(true);
  });

  test("graph-mock receives email_send request when tool is invoked via chat", async ({ page }) => {
    await resetGraphMock();

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER}: round-trip send`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_send",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // The plugin must have posted to the Graph sendMail endpoint.
    const reqs = (await getGraphMockRequests()) as Array<{ endpoint: string }>;
    expect(
      reqs.some((r) => r.endpoint === "/v1.0/me/sendMail"),
      `graph-mock received no sendMail request; saw: ${JSON.stringify(reqs)}`
    ).toBe(true);
  });
});
