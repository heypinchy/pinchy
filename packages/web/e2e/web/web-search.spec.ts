import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForBraveMock,
  resetBraveMock,
  getBraveRequests,
  getAdminEmail,
  getAdminPassword,
  login,
  createWebSearchConnection,
  waitForOpenClawConnected,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyDelete,
} from "./helpers";
import {
  FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER,
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

test.describe("pinchy-web — Brave Search E2E", () => {
  let cookie: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await seedSetup();
    await waitForPinchy();
    await waitForBraveMock();
    await resetBraveMock();
    cookie = await login();

    // Wait for OpenClaw to settle after the setup wizard restart before running
    // tests. The setup wizard triggers a full gateway restart (plugins/agents
    // changed); granting tools in the tests triggers another. We wait here so
    // the test-body timeout only covers the second restart, not both.
    const settled = await waitForOpenClawConnected(cookie, 120000);
    if (!settled) throw new Error("OpenClaw did not reconnect after setup wizard");
  });

  test("pinchy-web plugin loads after web-search connection is configured (Sherlock regression)", async () => {
    // This test guards against the staging incident where Dockerfile.pinchy
    // did not COPY pinchy-web, so OpenClaw logged "plugin not found" and
    // the tool was never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with
    // pinchy-web enabled and stays connected. We verify this by granting
    // the web search tool and confirming OpenClaw remains connected (i.e.
    // the regenerated config was accepted, not rejected with INVALID_CONFIG).

    // Create web-search connection
    const conn = await createWebSearchConnection(cookie);
    const connBody = await conn.text();
    expect(conn.status, connBody).toBe(201);
    const { id: connectionId } = JSON.parse(connBody) as { id: string };

    // Create a fresh shared agent (Smithers is personal — PATCH allowedTools is
    // refused for personal agents with 400. Custom shared agents accept it.)
    const createRes = await pinchyPost(
      "/api/agents",
      { name: `WebSearch-${Date.now()}`, templateId: "custom" },
      cookie
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBeLessThan(300);
    const { id: agentId } = JSON.parse(createBody) as { id: string };

    // Grant the web search tool to the agent (triggers regenerateOpenClawConfig)
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: ["pinchy_web_search"] },
      cookie
    );
    const patchBody = await patchRes.text();
    expect(patchRes.status, patchBody).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // Granting pinchy-web adds a new plugin entry — OpenClaw does a full
    // restart. Give 120s to cover the restart + reconnect window.
    const connected = await waitForOpenClawConnected(cookie, 120000);
    expect(connected).toBe(true);

    // The web-search connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const webConn = list.find((c) => c.type === "web-search");
    expect(webConn).toBeDefined();
    expect(webConn!.id).toBe(connectionId);
  });

  test.skip("Brave mock receives actual search request when tool is invoked via chat", async () => {
    // TODO: this test requires fake-ollama to support tool-call responses.
    //
    // Currently fake-ollama (packages/web/e2e/integration/fake-ollama-server.ts)
    // always returns a fixed string "Integration test response." — it does NOT
    // produce tool_use blocks. Until fake-ollama is extended to emit a
    // pinchy_web_search tool call for specific trigger phrases, we cannot
    // drive the full round-trip through the chat UI.
    //
    // When fake-ollama gains tool-call support:
    //   1. Seed brave-mock with custom results via seedBraveResults().
    //   2. Send a message through the chat WebSocket (or via the UI) that
    //      triggers the pinchy_web_search tool.
    //   3. Assert getBraveRequests() shows the expected query + a valid apiKey.
    //   4. Assert the apiKey is NOT the literal string "test-brave-api-key"
    //      (plugin must fetch credentials from Pinchy, not embed the raw value).
    void getBraveRequests; // referenced to avoid "unused import" lint errors
  });
});

// ── Dispatch probe (pinchy-web plugin coverage) ──────────────────────────────
// Proves pinchy-web loaded correctly and registerTool() worked end-to-end.
// Switches the default provider to fake-Ollama for this describe block only,
// creates a disposable agent with pinchy_web_search allowed, and asserts that
// the fake-LLM trigger results in an audit entry for tool.pinchy_web_search.
test.describe("Web dispatch probe (pinchy-web plugin coverage)", () => {
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

    // 4. Create web-search connection (so the plugin config is emitted).
    const connRes = await createWebSearchConnection(dispatchCookie, "E2E Web Dispatch");
    if (connRes.status !== 201)
      throw new Error(`Web connection creation failed: ${String(connRes.status)}`);
    dispatchConnectionId = ((await connRes.json()) as { id: string }).id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Web Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Allow pinchy_web_search — triggers regenerateOpenClawConfig() which now
    //    reads default_provider=ollama-local and emits the Ollama provider block.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["pinchy_web_search"] },
      dispatchCookie
    );
    if (patchRes.status !== 200) throw new Error(`Agent patch failed: ${String(patchRes.status)}`);

    // 7. Wait for OpenClaw to stabilise with the new Ollama config.
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

  test("pinchy_web_search dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER}: search the web`);
    await input.press("Enter");

    const found = await pollAuditForTool(page, {
      toolName: "pinchy_web_search",
      agentId: dispatchAgentId,
    });
    expect(found).toBe(true);
  });
});
