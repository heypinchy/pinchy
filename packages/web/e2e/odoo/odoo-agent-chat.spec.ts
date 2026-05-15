import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  login,
  createOdooConnection,
  setAgentPermissions,
  getAdminEmail,
  getAdminPassword,
  pinchyGet,
  pinchyPatch,
  pinchyPost,
  pinchyDelete,
} from "./helpers";
import {
  FAKE_OLLAMA_ODOO_SCHEMA_TOOL_TRIGGER,
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

const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

/** Poll /api/health/openclaw until `connected` is true or the timeout elapses. */
async function pollUntilOpenClawConnected(cookie: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await pinchyGet("/api/health/openclaw", cookie);
    if (res.ok) {
      const body = (await res.json()) as { connected?: boolean };
      if (body.connected) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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

    // Wait for the OpenClaw WS bridge to connect before any test runs.
    // Fix D (skip writeConfigAtomic in WS path) removes the OC internal SIGUSR1
    // restart that previously forced a reconnect event early in startup. In slow
    // CI environments the initial connect can now take longer than the 10 s window
    // inside individual tests — guard it here once, with a generous timeout.
    const ocConnected = await pollUntilOpenClawConnected(cookie, 60_000);
    if (!ocConnected) {
      throw new Error("OpenClaw WS bridge not connected after 60 s — aborting test suite");
    }

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

    // Poll /api/health/openclaw until OpenClaw reports connected=true after the
    // inotify hot-reload, with a generous timeout for slow CI environments.
    // The inotifywait grace period in start-openclaw.sh is 30 s; 10 s is enough
    // in practice (reload happens within ~1–2 s after the file write).
    const connected = await pollUntilOpenClawConnected(cookie, 10_000);
    expect(connected).toBe(true);

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

// ── Dispatch probe (pinchy-odoo plugin coverage) ─────────────────────────────
// Proves pinchy-odoo loaded correctly and registerTool() worked end-to-end.
// Switches the default provider to fake-Ollama for this describe block only,
// creates a disposable agent with odoo_schema allowed, and asserts that the
// fake-LLM trigger results in an audit entry for tool.odoo_schema.
test.describe("Odoo dispatch probe (pinchy-odoo plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Drain OC's config.apply rate-limit window. OC 5.3 allows ~3 calls per
    //    45 s per (device,IP) tuple. Tests 1–5 of this suite each trigger one
    //    regenerateOpenClawConfig() (PATCHes / setAgentPermissions cascades),
    //    so by the time this probe starts the rate-limit counter is at or near
    //    the cap. The second config.apply from this probe (after POST agent +
    //    PATCH allowedTools) then gets rejected with UNAVAILABLE, falls through
    //    to the inotify file-watcher fallback, and races a still-in-flight
    //    earlier config.apply that overwrites OC's in-memory state with stale
    //    content — leading to "unknown agent id" when the dispatch chat fires.
    //    A 45 s quiescent wait flushes the window so this probe's regens are
    //    the only ones contending.
    await new Promise((r) => setTimeout(r, 45_000));

    // 3. Swap default_provider to ollama-local and seed ollama_local_url.
    //    Pinchy can reach ollama.local via the extra_hosts mapping added to the
    //    docker-compose.odoo-test.yml overlay. OpenClaw already has this mapping.
    const dbUrl =
      process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 4. Login (API cookie).
    dispatchCookie = await login();

    // 4. Create Odoo connection so the agent config includes the plugin block.
    const connRes = await createOdooConnection(dispatchCookie, "E2E Odoo Dispatch");
    expect(connRes.status).toBe(201);
    dispatchConnectionId = ((await connRes.json()) as { id: string }).id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Odoo Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    expect(createRes.status).toBe(201);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Grant Odoo permissions → triggers regenerateOpenClawConfig() which now
    //    reads default_provider=ollama-local and emits the Ollama provider block.
    await setAgentPermissions(dispatchCookie, dispatchAgentId, dispatchConnectionId, [
      { model: "sale.order", operation: "read" },
    ]);

    // 7. Allow odoo_schema — second config regen with the tool in the allow-list.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["odoo_schema"] },
      dispatchCookie
    );
    expect(patchRes.status).toBe(200);

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

  test("odoo_schema dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_ODOO_SCHEMA_TOOL_TRIGGER}: describe Odoo models`);
    await input.press("Enter");

    const found = await pollAuditForTool(page, {
      toolName: "odoo_schema",
      agentId: dispatchAgentId,
    });
    expect(found).toBe(true);
  });
});
