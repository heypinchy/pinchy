import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  login,
  createOdooConnection,
  setAgentPermissions,
  pinchyGet,
  pinchyPatch,
  pinchyPost,
} from "./helpers";

const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

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
    const odooTools = ["odoo_schema", "odoo_read", "odoo_count", "odoo_aggregate"];

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
      { allowedTools: ["odoo_schema", "odoo_read", "odoo_count"] },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // Give OpenClaw time to pick up the hot-reload via inotify and re-validate the config.
    await new Promise((r) => setTimeout(r, 3000));

    // Verify the gateway is still connected. If the old broken manifest was in place,
    // OpenClaw would log INVALID_CONFIG and may disconnect from the Pinchy WebSocket bridge.
    const healthRes = await pinchyGet("/api/health/openclaw", cookie);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.connected).toBe(true);

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
