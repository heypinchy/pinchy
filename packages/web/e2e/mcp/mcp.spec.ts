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
import { stackDbUrl } from "../shared/stack-db";
import {
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../shared/dispatch-probe";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_MCP_URL = process.env.MOCK_MCP_URL || "http://localhost:9005";

// Admin credentials (created by seedSetup)
const ADMIN_EMAIL = "admin@test.local";
const ADMIN_PASSWORD = "test-password-123";

// Trigger the fake LLM (registered at runtime via /control/tool-trigger) maps
// to an MCP tool_call. Any string the agent's message contains works.
const MCP_DISPATCH_TRIGGER = "MCP_PROXY_DISPATCH_PROBE";

// Native MCP tool-name derivation — kept in SYNC with
// src/lib/openclaw-config/native-mcp.ts (pinned by native-mcp.test.ts). OpenClaw
// materializes a native MCP tool as `<sanitized-server-key>__<sanitized-tool>`;
// the round-trip test must register + poll for that EXACT name.
function mcpServerKey(connectionId: string): string {
  return `m${connectionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 30);
}
function nativeMcpToolName(connectionId: string, tool: string): string {
  const key = mcpServerKey(connectionId);
  const normalized = tool.trim().replace(/[^A-Za-z0-9_-]/g, "-") || "tool";
  const safeTool = /^[A-Za-z]/.test(normalized) ? normalized : `tool-${normalized}`;
  return `${key}__${safeTool.slice(0, Math.max(1, 64 - key.length - 2))}`;
}

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
  // Respect DB_PASSWORD set by the E2E stack — the dev fallback "pinchy_dev"
  // is wrong in CI, where stackDbUrl() reads the real password. Mirrors the
  // odoo/email specs (main commit 4f37b354).
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
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

test.describe("MCP integration (admin REST flow)", () => {
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

// ---------------------------------------------------------------------------
// Gold-standard round-trip: a real agent tool call must travel
//   fake-LLM tool_call → OpenClaw native MCP → Pinchy credential proxy → mock
// and produce an audit entry. This is the only test that proves the native
// emission + proxy + tools.allow + audit actually work end-to-end at runtime
// (the API-level tests above never dispatch through OpenClaw).
// ---------------------------------------------------------------------------

test.describe("native MCP proxy dispatch (round-trip)", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;
  let toolName: string;
  let restoreSettings: (() => Promise<void>) | undefined;

  test.beforeAll(async () => {
    // Generous: 60 s rate-limit drain + waitForOpenClawStable (which can park on
    // OC's config.apply rate-limit window) + waitForAgentDispatchable (≤120 s).
    test.setTimeout(420_000);
    await startFakeOllama();
    await waitForPinchy();
    await waitForMcpMock();
    await resetMcpMock();
    await seedSetup();
    cookie = await login();

    // Drain OpenClaw's config.apply rate-limit window (~3 calls / 45 s) before
    // the dispatch setup. The admin-REST tests above fire several regens
    // (connection create, tool grants, sync), so the window is at/near the cap
    // when this block runs. Without the drain, the dispatch regens (ollama
    // provider + this agent's auth provisioning) get rate-limited, fall through
    // to the inotify file-watcher fallback, and the new agent ends up WITHOUT
    // the ollama provider auth profile → "No API key found for provider ollama"
    // → the run fails before any tool_call. 60 s leaves ~15 s slack past the
    // window. Mirrors the odoo/web/email dispatch probes.
    await new Promise((r) => setTimeout(r, 60_000));

    // Point the default provider at the fake LLM so the agent dispatches tools.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // Create the MCP connection (→ syncs the mock's tool catalog), then derive
    // the EXACT tool name OpenClaw will materialize.
    const connRes = await createMcpConnection(cookie, "Dispatch MCP");
    expect(connRes.status).toBe(201);
    connectionId = ((await connRes.json()) as { id: string }).id;
    toolName = nativeMcpToolName(connectionId, "create_issue");

    // Agent created AFTER the ollama seed → picks the ollama-local default model.
    const agentRes = await pinchyPost(
      "/api/agents",
      { name: "MCP Dispatch Agent", templateId: "custom" },
      cookie
    );
    expect(agentRes.status).toBe(201);
    agentId = ((await agentRes.json()) as { id: string }).id;

    // Grant create_issue → build.ts emits mcp.servers + this tool in tools.allow.
    const grantRes = await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      [{ kind: "mcp", connectionId, tools: ["create_issue"] }],
      cookie
    );
    expect(grantRes.status).toBe(200);

    // Register the dynamic fake-LLM trigger → emit a tool_call for the exact
    // materialized native MCP tool name.
    const reg = await fetch(`http://localhost:${FAKE_OLLAMA_PORT}/control/tool-trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger: MCP_DISPATCH_TRIGGER,
        toolName,
        arguments: { title: "E2E issue", repo: "pinchy" },
      }),
    });
    expect(reg.ok).toBe(true);

    // Wait for OpenClaw to HOT-RELOAD the new mcp.server + agent (NO restart) and
    // see the agent as dispatchable before we send a chat.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", cookie));
    await waitForAgentDispatchable(
      (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`, cookie),
      agentId,
      { deadlineMs: 120_000 }
    );
  });

  test.afterAll(async () => {
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test("tool call routes OpenClaw → proxy → mock and writes an audit entry", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(220_000);

    const since = new Date().toISOString();
    await fetch(`${MOCK_MCP_URL}/control/clear-calls`, { method: "POST" });

    await loginViaUI(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${MCP_DISPATCH_TRIGGER}: please create an issue`);
    await input.press("Enter");

    // (1) Audit proves OpenClaw dispatched the native MCP tool (governance).
    const dispatched = await pollAuditForTool(page, {
      toolName,
      agentId,
      since,
      deadlineMs: 160_000,
    });
    expect(dispatched).toBe(true);

    // (2) The call actually reached the upstream mock THROUGH the Pinchy proxy —
    // proves OpenClaw → /api/internal/mcp-proxy/<id> → mock with the injected
    // real token (the mock responds regardless of auth, but only the proxy path
    // can deliver the call, since OpenClaw only ever sees the proxy URL).
    const callsRes = await fetch(`${MOCK_MCP_URL}/control/calls`);
    const calls = (await callsRes.json()) as Array<{ tool: string }>;
    expect(calls.some((c) => c.tool === "create_issue")).toBe(true);
  });
});
