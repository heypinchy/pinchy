import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForBraveMock,
  resetBraveMock,
  getBraveRequests,
  login,
  createWebSearchConnection,
  waitForOpenClawConnected,
  pinchyGet,
  pinchyPatch,
} from "./helpers";

test.describe("pinchy-web — Brave Search E2E", () => {
  let cookie: string;
  let agentId: string;

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

    // Get Smithers agent
    const agents = await pinchyGet("/api/agents", cookie);
    expect(agents.status).toBe(200);
    const agentList = (await agents.json()) as Array<{ name: string; id: string }>;
    const smithers = agentList.find((a) => a.name === "Smithers");
    if (!smithers) throw new Error("Smithers agent not found — was seedSetup successful?");
    agentId = smithers.id;
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
    expect(conn.status).toBe(201);
    const { id: connectionId } = (await conn.json()) as { id: string };

    // Grant web search tool to Smithers (triggers regenerateOpenClawConfig)
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: ["pinchy_web_search"] },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // granting pinchy-web adds a new plugin entry — OpenClaw does a full
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

  test("credentials endpoint returns web-search apiKey for the plugin", async () => {
    // The web-search connection is expected to already exist from test 1.
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const webConn = list.find((c) => c.type === "web-search");
    expect(webConn).toBeDefined();

    const creds = await pinchyGet(`/api/internal/integrations/${webConn!.id}/credentials`, cookie);
    expect(creds.status).toBe(200);
    const body = (await creds.json()) as {
      type: string;
      credentials: { apiKey: unknown };
    };
    expect(body.type).toBe("web-search");
    expect(body.credentials.apiKey).toBeTruthy();
    expect(typeof body.credentials.apiKey).toBe("string");
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
