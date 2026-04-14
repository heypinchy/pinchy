import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForPipedriveMock,
  resetPipedriveMock,
  login,
  createPipedriveConnection,
  deleteAllConnections,
  setAgentPermissions,
  pinchyGet,
  pinchyPatch,
  pinchyPost,
} from "./helpers";

const MOCK_PIPEDRIVE_URL = process.env.MOCK_PIPEDRIVE_URL || "http://localhost:9003";

test.describe.serial("Pipedrive Agent Chat", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForPipedriveMock();
    await resetPipedriveMock();
    cookie = await login();
    // Clean slate: remove any leftover connections from previous test files
    await deleteAllConnections(cookie);

    // Create Pipedrive connection
    const connRes = await createPipedriveConnection(cookie);
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
      { model: "deals", operation: "read" },
    ]);
    expect(putRes.status).toBe(200);

    // Read them back
    const getRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(getRes.status).toBe(200);
    const integrations = await getRes.json();

    expect(integrations).toHaveLength(1);
    expect(integrations[0].connectionId).toBe(connectionId);
    expect(integrations[0].permissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ model: "deals", operation: "read" })])
    );
  });

  test("agent allowedTools includes Pipedrive tools after PATCH", async () => {
    const pipedriveTools = [
      "pipedrive_schema",
      "pipedrive_read",
      "pipedrive_search",
      "pipedrive_summary",
      "pipedrive_create",
      "pipedrive_update",
      "pipedrive_delete",
      "pipedrive_merge",
      "pipedrive_relate",
      "pipedrive_convert",
    ];

    // PATCH the agent to allow Pipedrive tools
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: pipedriveTools },
      cookie
    );
    expect(patchRes.status).toBe(200);

    // Verify the agent now has those tools
    const getRes = await pinchyGet(`/api/agents/${agentId}`, cookie);
    expect(getRes.status).toBe(200);
    const agent = await getRes.json();

    expect(agent.allowedTools).toEqual(expect.arrayContaining(pipedriveTools));
  });

  test("sync captures entity accessibility", async () => {
    // Configure mock with restricted access for some entities
    const configRes = await fetch(`${MOCK_PIPEDRIVE_URL}/control/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deals: { read: true, create: true, update: true, delete: false },
        persons: { read: true, create: false, update: false, delete: false },
      }),
    });
    expect(configRes.status).toBe(200);

    // Trigger sync
    const syncRes = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.success).toBe(true);
    expect(syncBody.entities).toBeGreaterThan(0);

    // Verify the connection's cached data contains entities with operations
    const integrationsRes = await pinchyGet("/api/integrations", cookie);
    expect(integrationsRes.status).toBe(200);
    const integrations = await integrationsRes.json();
    const conn = integrations.find((c: { id: string }) => c.id === connectionId);
    expect(conn).toBeTruthy();
    expect(conn.data).toBeTruthy();

    // Find deals in the synced entities and check its operations
    const deals = conn.data.entities.find((e: { entity: string }) => e.entity === "deals");
    expect(deals).toBeTruthy();
    expect(deals.operations).toEqual({
      read: true,
      create: true,
      update: true,
      delete: false,
    });
  });

  test("audit trail endpoint validates auth", async () => {
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
          toolName: "pipedrive_read",
          agentId,
          sessionKey: `agent:${agentId}:user-test`,
          params: { entity: "deals" },
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
          toolName: "pipedrive_read",
          agentId,
          sessionKey: `agent:${agentId}:user-test`,
          params: { entity: "deals" },
          durationMs: 42,
        }),
      }
    );
    expect(badAuthRes.status).toBe(401);
  });
});
