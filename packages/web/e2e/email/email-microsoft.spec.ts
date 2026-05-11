import { test, expect, type Page } from "@playwright/test";
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
  waitForOpenClawConnected,
} from "./helpers";
import {
  FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER as FAKE_OLLAMA_EMAIL_LIST_TRIGGER,
  FAKE_OLLAMA_EMAIL_LIST_TOOL_RESPONSE as FAKE_OLLAMA_EMAIL_LIST_RESPONSE,
  FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER as FAKE_OLLAMA_EMAIL_SEND_TRIGGER,
  FAKE_OLLAMA_EMAIL_SEND_TOOL_RESPONSE as FAKE_OLLAMA_EMAIL_SEND_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";

async function loginWithPage(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(getAdminEmail());
  await page.getByLabel("Password", { exact: true }).fill(getAdminPassword());
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
}

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

  test("Graph mock receives email_list request when tool is invoked via chat", async ({ page }) => {
    if (!connectionId) throw new Error("connectionId not set — did test 1 run?");

    // Reset so we start with a clean request log, then re-seed messages
    await resetGraphMock();
    await seedGraphMockMessages([
      {
        subject: "Test email from graph-mock",
        from: "sender@example.com",
        body: "Hello from Microsoft E2E test",
        isRead: false,
      },
    ]);

    await loginWithPage(page);
    await page.goto(`/chat/${agentId}`);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    await input.fill(FAKE_OLLAMA_EMAIL_LIST_TRIGGER);
    await input.press("Enter");

    // Wait for the LLM's follow-up text response after the tool round-trip
    await expect(page.getByText(FAKE_OLLAMA_EMAIL_LIST_RESPONSE)).toBeVisible({ timeout: 60000 });

    // The plugin must have called the Graph messages endpoint
    const requests = await getGraphMockRequests();
    const listReq = (requests as Array<{ endpoint: string }>).find(
      (r) => r.endpoint === "/v1.0/me/messages" || r.endpoint?.startsWith("/v1.0/me/mailFolders/")
    );
    expect(listReq).toBeDefined();
  });

  test("Graph mock receives email_send request when tool is invoked via chat", async ({ page }) => {
    if (!connectionId) throw new Error("connectionId not set — did test 1 run?");

    // Grant send permission (replaces existing read+search with read+search+send)
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
            { model: "email", operation: "send" },
          ],
        }),
      }
    );
    expect(permRes.status).toBe(200);

    // Wait for OpenClaw to reconnect after the config change
    const reconnected = await waitForOpenClawConnected(cookie, 120000);
    expect(reconnected).toBe(true);

    // Reset mock so the request log is clean for this assertion
    await resetGraphMock();

    await loginWithPage(page);
    await page.goto(`/chat/${agentId}`);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    await input.fill(FAKE_OLLAMA_EMAIL_SEND_TRIGGER);
    await input.press("Enter");

    // Wait for the LLM's follow-up text response after the tool round-trip
    await expect(page.getByText(FAKE_OLLAMA_EMAIL_SEND_RESPONSE)).toBeVisible({ timeout: 60000 });

    // The plugin must have posted to the sendMail endpoint
    const requests = await getGraphMockRequests();
    const sendReq = (requests as Array<{ endpoint: string; method?: string }>).find(
      (r) => r.endpoint === "/v1.0/me/sendMail"
    );
    expect(sendReq).toBeDefined();
  });
});
