import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForGraphMock,
  resetGraphMock,
  seedGraphMockMessages,
  getGraphMockRequests,
  createMicrosoftConnectionInDb,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  waitForOpenClawConnected,
} from "./helpers";

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

  test("pinchy-email plugin loads after Microsoft connection is configured (staging regression)", async () => {
    // This test guards against the scenario where pinchy-email is not in the
    // extensions volume, so OpenClaw logs "plugin not found" and the email tools
    // are never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with pinchy-email
    // enabled and stays connected. We verify this by granting email permissions
    // and confirming OpenClaw remains connected (i.e. the regenerated config was
    // accepted, not rejected with INVALID_CONFIG).

    // Seed some messages so the graph-mock has data if tools are invoked
    await seedGraphMockMessages([
      {
        subject: "Test email from graph-mock",
        from: "sender@example.com",
        body: "Hello from Microsoft E2E test",
        isRead: false,
      },
    ]);

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

    // The Microsoft connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const microsoftConn = list.find((c) => c.type === "microsoft");
    expect(microsoftConn).toBeDefined();
    expect(microsoftConn!.id).toBe(connectionId);
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
    expect(emailIntegration!.connectionType).toBe("microsoft");

    const ops = emailIntegration!.permissions.map((p) => p.operation);
    expect(ops).toContain("read");
    expect(ops).toContain("search");
    expect(ops).not.toContain("send");
    expect(ops).not.toContain("draft");
  });

  test.skip("Graph mock receives email_list request when tool is invoked via chat", async () => {
    // TODO: this test requires fake-ollama to support tool-call responses.
    //
    // Currently fake-ollama (packages/web/e2e/integration/fake-ollama-server.ts)
    // always returns a fixed string "Integration test response." — it does NOT
    // produce tool_use blocks. Until fake-ollama is extended to emit an
    // email_list tool call for specific trigger phrases, we cannot drive the
    // full round-trip through the chat UI.
    //
    // When fake-ollama gains tool-call support:
    //   1. Send a message through the chat WebSocket that triggers email_list.
    //   2. Assert graph-mock received a GET /v1.0/me/messages request via
    //      getGraphMockRequests().
    //   3. Assert the plugin fetched credentials via /api/internal/integrations
    //      (check requestLog via /control/requests).
    //   4. Assert the response includes the seeded test email from seedGraphMockMessages.
    void getGraphMockRequests; // referenced to avoid "unused import" lint errors
  });

  test.skip("Graph mock receives email_send request when tool is invoked via chat", async () => {
    // TODO: requires fake-ollama tool-call support (see skip above).
    //
    // When fake-ollama gains tool-call support:
    //   1. Grant email send permission via PUT /api/agents/:id/integrations.
    //   2. Trigger email_send tool via chat.
    //   3. Assert graph-mock received a POST /v1.0/me/sendMail request.
    //   4. Confirm the plugin did NOT embed the raw access token — it must
    //      have fetched credentials from /api/internal/integrations/:id/credentials.
    void pinchyPost; // referenced to avoid "unused import" lint errors
  });
});
