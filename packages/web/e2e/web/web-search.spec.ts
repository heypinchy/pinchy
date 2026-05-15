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
  let dispatchAgentId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Seed ollama_local_url and switch default provider to ollama-local.
    const dbUrl =
      process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
    const { default: postgres } = await import("postgres");
    const sql = postgres(dbUrl);
    await sql`
      INSERT INTO settings (key, value, encrypted) VALUES
        ('ollama_local_url', ${"http://ollama.local:" + String(FAKE_OLLAMA_PORT)}, false),
        ('default_provider', 'ollama-local', false)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = false
    `;
    await sql.end();

    // 3. Login
    dispatchCookie = await login();

    // 4. Create web-search connection (so the plugin config is emitted).
    const connRes = await createWebSearchConnection(dispatchCookie, "E2E Web Dispatch");
    if (connRes.status !== 201)
      throw new Error(`Web connection creation failed: ${String(connRes.status)}`);

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

    // 7. Wait for OpenClaw to stabilise with the new Ollama config (5 s consecutive).
    const deadline = Date.now() + 60_000;
    let connectedSince: number | null = null;
    while (Date.now() < deadline) {
      const res = await pinchyGet("/api/health/openclaw", dispatchCookie);
      if (res.ok) {
        const body = (await res.json()) as { connected?: boolean };
        if (body.connected) {
          connectedSince ??= Date.now();
          if (Date.now() - connectedSince >= 5000) break;
        } else {
          connectedSince = null;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!connectedSince || Date.now() - connectedSince < 5000) {
      throw new Error("OpenClaw did not stabilise after Ollama config regen");
    }
  });

  test.afterAll(async () => {
    if (dispatchAgentId) {
      await pinchyDelete(`/api/agents/${dispatchAgentId}`, dispatchCookie);
    }
    await stopFakeOllama();
  });

  test("pinchy_web_search dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(getAdminEmail());
    await page.getByLabel("Password", { exact: true }).fill(getAdminPassword());
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER}: search the web`);
    await input.press("Enter");

    const deadline = Date.now() + 30000;
    let found = false;
    while (Date.now() < deadline) {
      const res = await page.request.get("/api/audit?eventType=tool.pinchy_web_search&limit=10");
      expect(res.status()).toBe(200);
      const audit = await res.json();
      found = (
        audit.entries as Array<{ resource: string | null; detail: { toolName?: string } | null }>
      ).some(
        (entry) =>
          entry.resource === `agent:${dispatchAgentId}` &&
          entry.detail?.toolName === "pinchy_web_search"
      );
      if (found) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  });
});
