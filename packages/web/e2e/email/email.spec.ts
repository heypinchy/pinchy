import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForGmailMock,
  resetGmailMock,
  createGoogleConnectionInDb,
  getAdminEmail,
  getAdminPassword,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyDelete,
  waitForOpenClawConnected,
} from "./helpers";
import {
  FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";

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

  test.skip("Gmail mock receives email_list request when tool is invoked via chat", async () => {
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
    //   2. Assert gmail-mock received a GET /gmail/v1/users/me/messages request.
    //   3. Assert the plugin fetched credentials via /api/internal/integrations
    //      (check requestLog via /control/requests).
    //   4. Assert the response includes the seeded test email from resetGmailMock.
    void resetGmailMock; // referenced to avoid "unused import" lint errors
  });

  test.skip("Gmail mock receives email_send request when tool is invoked via chat", async () => {
    // TODO: requires fake-ollama tool-call support (see skip above).
    //
    // When fake-ollama gains tool-call support:
    //   1. Grant email send permission via PUT /api/agents/:id/integrations.
    //   2. Trigger email_send tool via chat.
    //   3. Assert getSentMessages() returns the sent message with correct content.
    //   4. Confirm the plugin did NOT embed the raw access token — it must
    //      have fetched credentials from /api/internal/integrations/:id/credentials.
    void pinchyPost; // referenced to avoid "unused import" lint errors
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

    // 6. Grant email read permissions → triggers regenerateOpenClawConfig() which
    //    now reads default_provider=ollama-local and emits the Ollama provider block.
    const permRes = await fetch(
      (process.env.PINCHY_URL || "http://localhost:7777") +
        `/api/agents/${dispatchAgentId}/integrations`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: dispatchCookie,
          Origin: process.env.PINCHY_URL || "http://localhost:7777",
        },
        body: JSON.stringify({
          connectionId: dispatchConnectionId,
          permissions: [{ model: "email", operation: "read" }],
        }),
      }
    );
    if (permRes.status !== 200)
      throw new Error(`Permissions grant failed: ${String(permRes.status)}`);

    // 7. Allow email_list — second config regen with the tool in the allow-list.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["email_list"] },
      dispatchCookie
    );
    if (patchRes.status !== 200) throw new Error(`Agent patch failed: ${String(patchRes.status)}`);

    // 8. Wait for OpenClaw to stabilise with the new Ollama config (5 s consecutive).
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

  test("email_list dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(getAdminEmail());
    await page.getByLabel("Password", { exact: true }).fill(getAdminPassword());
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER}: list my emails`);
    await input.press("Enter");

    const deadline = Date.now() + 30000;
    let found = false;
    while (Date.now() < deadline) {
      const res = await page.request.get("/api/audit?eventType=tool.email_list&limit=10");
      expect(res.status()).toBe(200);
      const audit = await res.json();
      found = (
        audit.entries as Array<{ resource: string | null; detail: { toolName?: string } | null }>
      ).some(
        (entry) =>
          entry.resource === `agent:${dispatchAgentId}` && entry.detail?.toolName === "email_list"
      );
      if (found) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  });
});
