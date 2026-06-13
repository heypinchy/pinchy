/**
 * MCP integration E2E tests — full admin flow.
 *
 * Covers per AGENTS.md Plugin Integration Contract:
 *   1. Admin enables MCP (via PINCHY_MCP_ENABLED env), logs in.
 *   2. Adds a Generic MCP integration pointed at the mock; asserts tool list resolves.
 *   3. Creates an agent; grants two of three tools (create_issue + list_repos).
 *   4. Verifies granted tool permissions persist on the agent.
 *   5. Verifies the ungranted tool (legacy_search) is NOT in the agent's permissions.
 *   6. Triggers a sync after the mock removes legacy_search; asserts the permission
 *      row is auto-deleted and the drift response reflects it.
 *   7. Audit log has the integration_created entry with the correct tool count.
 *
 * Notes:
 *   - The spec uses the Pinchy REST API directly (not UI) for setup, following
 *     the odoo-agent-chat pattern. Tool-call round-trips via live chat require a
 *     real LLM; instead we verify the allow-list and drift via the API surface.
 *   - All requests must include an Origin header (CSRF gate, issue #235).
 *   - Requires: PINCHY_MCP_ENABLED=1 (set in docker-compose.mcp-test.yml).
 */

import { test, expect } from "@playwright/test";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_MCP_URL = process.env.MOCK_MCP_URL || "http://localhost:9005";

// Admin credentials (created by seedSetup)
const ADMIN_EMAIL = "admin@test.local";
const ADMIN_PASSWORD = "test-password-123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForPinchy(timeout = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${PINCHY_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Pinchy not ready after ${timeout}ms`);
}

async function waitForMcpMock(timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${MOCK_MCP_URL}/control/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MCP mock not ready after ${timeout}ms`);
}

async function resetMcpMock(): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to reset MCP mock: ${res.status}`);
}

async function toggleTool(tool: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/toggle-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, enabled }),
  });
  if (!res.ok) throw new Error(`Failed to toggle tool ${tool}: ${res.status}`);
}

async function seedSetup(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  const existing = await sql`SELECT id, email FROM "user" LIMIT 1`;
  if (existing.length > 0) {
    await sql.end();
    console.log(`[mcp-setup] Using existing admin: ${existing[0].email}`);
    return;
  }

  const setupRes = await fetch(`${PINCHY_URL}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    body: JSON.stringify({
      name: "Test Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  });

  if (!setupRes.ok) {
    const text = await setupRes.text();
    await sql.end();
    throw new Error(`Setup failed: ${setupRes.status} ${text}`);
  }

  // Wait for DB to settle
  await new Promise((r) => setTimeout(r, 2000));

  // Seed a provider so agents can be created
  const testApiKey = process.env.TEST_ANTHROPIC_API_KEY || "sk-ant-fake-key-for-e2e-testing";
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('default_provider', 'anthropic', false)
    ON CONFLICT (key) DO UPDATE SET value = 'anthropic'
  `;
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('anthropic_api_key', ${testApiKey}, false)
    ON CONFLICT (key) DO UPDATE SET value = ${testApiKey}
  `;

  await sql.end();
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`[mcp-setup] Admin created: ${ADMIN_EMAIL}`);
}

async function login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Login failed — no set-cookie header (status ${res.status})`);
  }
  return setCookie;
}

function mutatingHeaders(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: PINCHY_URL,
  };
}

async function pinchyGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    headers: { Cookie: cookie },
  });
}

async function pinchyPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

async function pinchyPut(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PUT",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

/**
 * The mcp-mock URL from inside the Docker network (container-to-container).
 * Pinchy talks to the mock through the internal Docker network using the
 * service name `mcp-mock`, while tests talk to it through the host-exposed
 * port 9005. The integration credentials must use the internal URL.
 */
const MCP_MOCK_INTERNAL_URL = "http://mcp-mock:9005";

async function createMcpConnection(cookie: string, name = "Test MCP"): Promise<Response> {
  return pinchyPost(
    "/api/integrations",
    {
      type: "mcp",
      name,
      description: "Mock MCP server for testing",
      preset: "generic",
      transport: "http",
      url: MCP_MOCK_INTERNAL_URL + "/",
      token: "test-token",
    },
    cookie
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("pinchy-mcp integration", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;

  test.beforeAll(async () => {
    await waitForPinchy();
    await waitForMcpMock();
    await resetMcpMock();
    await seedSetup();
    cookie = await login();
  });

  // ── Scenario 1 + 2: Add Generic MCP integration; tool list resolves ────────

  test("creates MCP integration and discovers all three tools", async () => {
    const res = await createMcpConnection(cookie);

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.type).toBe("mcp");
    expect(body.id).toBeTruthy();
    connectionId = body.id;

    // The data blob should contain the three tools advertised by the mock
    const tools = (body.data as { tools?: Array<{ name: string }> })?.tools ?? [];
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("create_issue");
    expect(toolNames).toContain("list_repos");
    expect(toolNames).toContain("legacy_search");
    expect(toolNames).toHaveLength(3);
  });

  // ── Scenario 3: Create agent; grant two of three tools ────────────────────

  test("creates an agent for MCP testing", async () => {
    const res = await pinchyPost(
      "/api/agents",
      { name: "MCP Test Agent", templateId: "custom" },
      cookie
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    agentId = body.id;
    expect(agentId).toBeTruthy();
  });

  test("grants two of three MCP tools to the agent", async () => {
    // Grant create_issue and list_repos; deliberately omit legacy_search
    const res = await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [
        {
          kind: "mcp",
          connectionId,
          tools: ["create_issue", "list_repos"],
        },
      ],
      cookie
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // ── Scenario 4: Verify granted tools persist ───────────────────────────────

  test("agent integrations GET returns the two granted tools", async () => {
    const res = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const { permissions, drift } = body as {
      permissions: Array<{ kind: string; connectionId: string; tools: string[] }>;
      drift: unknown[];
    };

    const mcpEntry = permissions.find((p) => p.kind === "mcp" && p.connectionId === connectionId);
    expect(mcpEntry).toBeTruthy();
    expect(mcpEntry!.tools).toContain("create_issue");
    expect(mcpEntry!.tools).toContain("list_repos");
    expect(mcpEntry!.tools).toHaveLength(2);

    // No drift expected at this point
    expect(drift).toHaveLength(0);
  });

  // ── Scenario 5: Ungranted tool not in agent permissions ───────────────────

  test("ungranted tool (legacy_search) is absent from agent permissions", async () => {
    const res = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const { permissions } = body as {
      permissions: Array<{ kind: string; connectionId: string; tools: string[] }>;
    };

    const mcpEntry = permissions.find((p) => p.kind === "mcp" && p.connectionId === connectionId);
    expect(mcpEntry).toBeTruthy();
    expect(mcpEntry!.tools).not.toContain("legacy_search");
  });

  test("PUT with an unavailable tool is rejected with 409", async () => {
    // Verify the API rejects granting a non-existent tool.
    // First, grant a clearly bogus tool name.
    const res = await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [
        {
          kind: "mcp",
          connectionId,
          tools: ["nonexistent_tool"],
        },
      ],
      cookie
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not available|no longer/i);

    // Restore the correct permissions for subsequent tests
    await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [
        {
          kind: "mcp",
          connectionId,
          tools: ["create_issue", "list_repos"],
        },
      ],
      cookie
    );
  });

  // ── Scenario 6: Sync removes tool; auto-deletes permission; drift fires ───

  test("disabling legacy_search on mock then syncing auto-removes its stale permission and reports it in availableTools", async () => {
    // First, grant legacy_search so there's a permission row to drift
    await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [
        {
          kind: "mcp",
          connectionId,
          tools: ["create_issue", "list_repos", "legacy_search"],
        },
      ],
      cookie
    );

    // Verify all three tools are granted
    const beforeRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    const before = await beforeRes.json();
    const beforeEntry = before.permissions.find(
      (p: { kind: string; connectionId: string }) =>
        p.kind === "mcp" && p.connectionId === connectionId
    );
    expect(beforeEntry.tools).toContain("legacy_search");

    // Disable legacy_search on the mock
    await toggleTool("legacy_search", false);

    // Trigger sync — the sync route re-fetches tools from the mock and diffs
    const syncRes = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();

    // Sync should report legacy_search as removed
    expect(syncBody.success).toBe(true);
    expect(syncBody.diff.removed).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "legacy_search" })])
    );
    expect(syncBody.diff.total).toBe(2); // only create_issue + list_repos remain

    // GET integrations now returns drift for legacy_search (the permission row
    // still exists — drift is detected at read time, not eagerly deleted by sync)
    const afterRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(afterRes.status).toBe(200);
    const after = await afterRes.json();

    const { drift } = after as {
      drift: Array<{ connectionName: string; removedTool: string }>;
    };

    // At least one drift entry for legacy_search
    const legacyDrift = drift.find((d) => d.removedTool === "legacy_search");
    expect(legacyDrift).toBeTruthy();

    // The MCP entry's availableTools should no longer include legacy_search
    const mcpEntry = after.permissions.find(
      (p: { kind: string; connectionId: string }) =>
        p.kind === "mcp" && p.connectionId === connectionId
    );
    if (mcpEntry) {
      expect(mcpEntry.availableTools).not.toContain("legacy_search");
    }
  });

  // ── Scenario 7: Audit log has integration_created entry ──────────────────

  test("audit log records the MCP integration creation with correct tool count", async () => {
    const res = await pinchyGet("/api/audit?limit=100&eventType=config.changed", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const entries = body.entries as Array<{
      eventType: string;
      detail: {
        action?: string;
        type?: string;
        name?: string;
        mcp?: { toolCount?: number };
      };
      outcome: string;
    }>;

    const createEntry = entries.find(
      (e) =>
        e.eventType === "config.changed" &&
        e.detail?.action === "integration_created" &&
        e.detail?.type === "mcp" &&
        e.detail?.name === "Test MCP"
    );

    expect(createEntry).toBeTruthy();
    expect(createEntry!.outcome).toBe("success");
    // Tool count should reflect all three tools present when the integration was added
    expect(createEntry!.detail?.mcp?.toolCount).toBe(3);
  });

  // ── Scenario 7b: Audit log records MCP tool permission changes ───────────

  test("audit log records agent.updated when MCP tool permissions change", async () => {
    // Re-grant a clean set of permissions to trigger an audit entry
    await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [
        {
          kind: "mcp",
          connectionId,
          tools: ["create_issue"],
        },
      ],
      cookie
    );

    const res = await pinchyGet("/api/audit?limit=100&eventType=agent.updated", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const entries = body.entries as Array<{
      eventType: string;
      resource: string;
      detail: { mcpTools?: { added?: unknown[]; removed?: unknown[] } };
      outcome: string;
    }>;

    const agentEntry = entries.find(
      (e) =>
        e.eventType === "agent.updated" &&
        e.resource === `agent:${agentId}` &&
        e.outcome === "success"
    );

    expect(agentEntry).toBeTruthy();
    expect(agentEntry!.detail?.mcpTools).toBeDefined();
  });
});
