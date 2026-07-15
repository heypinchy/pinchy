/**
 * MCP integration E2E tests — full admin flow + native proxy dispatch round-trip.
 *
 * Covers per AGENTS.md Plugin Integration Contract (see the "Plugin
 * Integration Contract" discussion in
 * docs/plans/2026-06-30-mcp-port-to-main.md T10 status — MCP is deliberately
 * NOT a Pinchy plugin, so this spec is this feature's ONLY behavior-level E2E
 * coverage; no drift guard enforces its existence the way
 * plugin-tool-coverage.test.ts does for packages/plugins/pinchy-*):
 *
 *   1. Admin enables MCP (via PINCHY_MCP_ENABLED, set in
 *      docker-compose.mcp-test.yml), logs in.
 *   2. Adds a Generic MCP integration pointed at the mock; asserts tool
 *      discovery resolves all three tools.
 *   3. Creates an agent; grants two of three tools (create_issue + list_repos).
 *   4. Verifies granted tool permissions persist on the agent, and the
 *      ungranted tool (legacy_search) is absent.
 *   5. A grant referencing a tool the connection doesn't expose is rejected.
 *   6. Disabling a tool on the mock then syncing reflects the removal
 *      (tool count + diff), and a later grant of that tool is rejected too
 *      (drift is enforced at write time against the connection's CURRENT
 *      synced tools — see agent-integrations route.ts).
 *   7. Audit log has the integration.created entry with the correct tool
 *      count, and a config.changed entry for the permission change.
 *   8. Gold-standard round trip: a fake-LLM tool_call travels
 *      OpenClaw (native mcp.servers) -> Pinchy credential proxy -> mock,
 *      and produces an audit entry — the only test that proves the native
 *      emission + proxy + tools.allow + audit actually work end-to-end at
 *      runtime (the admin-REST tests above never dispatch through OpenClaw).
 *      Also proves per-tool gating (only the granted tool reaches the model)
 *      and — live, not just read from OpenClaw's source — that the T7
 *      dynamic per-connection skill's index entry reaches the model's prompt.
 *   9. Rotating the connection's token takes effect on the very next
 *      dispatch, with no OpenClaw restart and no explicit config-regenerate
 *      call from the test — proving the credential proxy never caches a
 *      third-party token (T6/T4: MCP's proxy re-reads + decrypts fresh on
 *      every request, unlike Pattern B's 5-minute TTL cache).
 *
 * Notes:
 *   - The admin-REST-flow describe block uses Pinchy's REST API directly
 *     (not the UI), following the odoo-agent-chat / odoo-permissions
 *     pattern. Only the dispatch round-trip drives the chat UI, because
 *     that's the only thing that requires a real browser session.
 *   - All mutating requests must include an Origin header (CSRF gate, #235)
 *     — handled by helpers.ts's pinchyPost/pinchyPut/pinchyPatch.
 *   - Requires: PINCHY_MCP_ENABLED=1 (set in docker-compose.mcp-test.yml).
 *   - The integration suite shares ONE OpenClaw session across specs and
 *     needs unique trigger strings per turn; this suite runs in its own
 *     isolated mcp-test stack (own DB, own OpenClaw), but trigger strings
 *     are still kept unique per dispatch (PROBE_1/PROBE_2) since both fire
 *     in the same agent's session within this file.
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
import {
  seedSetup,
  waitForPinchy,
  waitForMcpMock,
  resetMcpMock,
  toggleMcpMockTool,
  requireMcpMockToken,
  clearMcpMockCalls,
  getMcpMockCalls,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  createMcpConnection,
  setAgentMcpPermissions,
  getAdminEmail,
  getAdminPassword,
} from "./helpers";

// Native MCP tool-name derivation — deliberately duplicated here rather than
// imported, so the spec's expectations stay independent of the implementation
// under test. Kept in SYNC with src/lib/openclaw-config/native-mcp.ts (pinned
// by native-mcp.test.ts). OpenClaw materializes a native MCP tool as
// `<sanitized-server-key>__<sanitized-tool>`; the round-trip test must
// register + poll for that EXACT name.
function mcpServerKey(connectionId: string): string {
  return `m${connectionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 30);
}
function nativeMcpToolName(connectionId: string, tool: string): string {
  const key = mcpServerKey(connectionId);
  const normalized = tool.trim().replace(/[^A-Za-z0-9_-]/g, "-") || "tool";
  const safeTool = /^[A-Za-z]/.test(normalized) ? normalized : `tool-${normalized}`;
  return `${key}__${safeTool.slice(0, Math.max(1, 64 - key.length - 2))}`;
}
// Kept in SYNC with src/lib/skills/mcp-skill.ts's mcpSkillId — the frontmatter
// `name` OpenClaw's skill-eligibility filter matches against
// agents.list[].skills, and what its <available_skills> prompt block renders
// verbatim (see the round-trip test's live skill-prompt assertion below).
function mcpSkillId(connectionId: string): string {
  return `mcp-${connectionId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Admin REST flow
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

  test("creates MCP integration and discovers all three tools", async () => {
    const res = await createMcpConnection(cookie, { name: "Test MCP" });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.type).toBe("mcp");
    expect(body.id).toBeTruthy();
    connectionId = body.id;

    const tools = (body.data as { tools?: Array<{ name: string }> })?.tools ?? [];
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["create_issue", "legacy_search", "list_repos"]);
  });

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
    // Grant create_issue and list_repos; deliberately omit legacy_search.
    const res = await setAgentMcpPermissions(cookie, agentId, connectionId, [
      "create_issue",
      "list_repos",
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("agent integrations GET returns the two granted tools, not the ungranted one", async () => {
    const res = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(res.status).toBe(200);
    const groups = (await res.json()) as Array<{
      connectionId: string;
      permissions: Array<{ model: string; operation: string }>;
    }>;

    const mcpGroup = groups.find((g) => g.connectionId === connectionId);
    expect(mcpGroup).toBeTruthy();
    const operations = mcpGroup!.permissions.map((p) => p.operation).sort();
    expect(operations).toEqual(["create_issue", "list_repos"]);
  });

  test("PUT with an unavailable tool is rejected with 400 and leaves existing grants untouched", async () => {
    const res = await setAgentMcpPermissions(cookie, agentId, connectionId, ["nonexistent_tool"]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown mcp tool/i);

    const after = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    const groups = (await after.json()) as Array<{
      connectionId: string;
      permissions: Array<{ operation: string }>;
    }>;
    const mcpGroup = groups.find((g) => g.connectionId === connectionId);
    expect(mcpGroup!.permissions.map((p) => p.operation).sort()).toEqual([
      "create_issue",
      "list_repos",
    ]);
  });

  test("disabling legacy_search on the mock then syncing reports it removed, and a later grant of it is rejected", async () => {
    // Grant legacy_search too so there's something real to watch disappear.
    await setAgentMcpPermissions(cookie, agentId, connectionId, [
      "create_issue",
      "list_repos",
      "legacy_search",
    ]);

    await toggleMcpMockTool("legacy_search", false);

    const syncRes = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.success).toBe(true);
    expect(syncBody.tools).toBe(2); // only create_issue + list_repos remain
    expect(syncBody.diff).toEqual({ added: 0, removed: 1 });

    // The write-time guard re-checks against the connection's CURRENT synced
    // tools, not the tools that existed when a stale grant was written — a
    // fresh grant of the just-removed tool is rejected.
    const grantRes = await setAgentMcpPermissions(cookie, agentId, connectionId, ["legacy_search"]);
    expect(grantRes.status).toBe(400);

    // Restore a clean grant set for the audit assertions below.
    await setAgentMcpPermissions(cookie, agentId, connectionId, ["create_issue"]);
  });

  test("audit log records the MCP integration creation with correct tool count", async () => {
    const res = await pinchyGet("/api/audit?limit=100&eventType=integration.created", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const entries = body.entries as Array<{
      resource: string | null;
      detail: { type?: string; name?: string; toolCount?: number } | null;
      outcome: string;
    }>;

    const createEntry = entries.find(
      (e) => e.resource === `integration:${connectionId}` && e.detail?.type === "mcp"
    );

    expect(createEntry).toBeTruthy();
    expect(createEntry!.outcome).toBe("success");
    expect(createEntry!.detail?.name).toBe("Test MCP");
    // Tool count reflects all three tools present when the integration was added.
    expect(createEntry!.detail?.toolCount).toBe(3);
  });

  test("audit log records config.changed when MCP tool permissions change", async () => {
    const res = await pinchyGet("/api/audit?limit=100&eventType=config.changed", cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const entries = body.entries as Array<{
      resource: string | null;
      detail: {
        action?: string;
        connectionId?: string;
        changes?: { added?: unknown[]; removed?: unknown[] };
      } | null;
      outcome: string;
    }>;

    const permEntry = entries.find(
      (e) =>
        e.resource === `agent:${agentId}` &&
        e.detail?.action === "agent_integration_permissions_updated" &&
        e.detail?.connectionId === connectionId
    );

    expect(permEntry).toBeTruthy();
    expect(permEntry!.outcome).toBe("success");
    expect(permEntry!.detail?.changes).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Gold-standard round-trip: a real agent tool call must travel
//   fake-LLM tool_call -> OpenClaw native MCP -> Pinchy credential proxy -> mock
// and produce an audit entry. This is the only test that proves the native
// emission + proxy + tools.allow + audit actually work end-to-end at runtime
// (the API-level tests above never dispatch through OpenClaw).
// ---------------------------------------------------------------------------

test.describe("native MCP proxy dispatch (round-trip)", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;
  let createIssueToolName: string;
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
    // the ollama provider auth profile -> "No API key found for provider
    // ollama" -> the run fails before any tool_call. 60 s leaves ~15 s slack
    // past the window. Mirrors the odoo/web/email dispatch probes.
    await new Promise((r) => setTimeout(r, 60_000));

    // Point the default provider at the fake LLM so the agent dispatches tools.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // From here on the mock only accepts this exact bearer token — the first
    // dispatch test below proves the proxy injects the real, connection-scoped
    // decrypted token (not e.g. the gateway bootstrap token OpenClaw itself
    // holds, and not no token at all).
    await requireMcpMockToken("rotation-token-v1");

    const connRes = await createMcpConnection(cookie, {
      name: "Dispatch MCP",
      token: "rotation-token-v1",
    });
    expect(connRes.status).toBe(201);
    connectionId = ((await connRes.json()) as { id: string }).id;
    createIssueToolName = nativeMcpToolName(connectionId, "create_issue");

    // Agent created AFTER the ollama seed -> picks the ollama-local default model.
    const agentRes = await pinchyPost(
      "/api/agents",
      { name: "MCP Dispatch Agent", templateId: "custom" },
      cookie
    );
    expect(agentRes.status).toBe(201);
    agentId = ((await agentRes.json()) as { id: string }).id;

    // Grant ONLY create_issue -> list_repos and legacy_search stay ungranted,
    // so the first dispatch test below can assert the PER-TOOL gate on this
    // connection, not just "the connection works at all".
    const grantRes = await setAgentMcpPermissions(cookie, agentId, connectionId, ["create_issue"]);
    expect(grantRes.status).toBe(200);

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

  test("tool call routes OpenClaw -> proxy -> mock, writes an audit entry, gates per-tool, and the dynamic skill reaches the model's prompt", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(220_000);

    const since = new Date().toISOString();
    await clearMcpMockCalls();

    const trigger = "MCP_PROXY_DISPATCH_PROBE_1";
    const reg = await fetch(`http://localhost:${FAKE_OLLAMA_PORT}/control/tool-trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger,
        toolName: createIssueToolName,
        arguments: { title: "E2E issue", repo: "pinchy" },
      }),
    });
    expect(reg.ok).toBe(true);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${trigger}: please create an issue`);
    await input.press("Enter");

    // (1) Audit proves OpenClaw dispatched the native MCP tool (governance).
    const dispatched = await pollAuditForTool(page, {
      toolName: createIssueToolName,
      agentId,
      since,
      deadlineMs: 160_000,
    });
    expect(dispatched).toBe(true);

    // (2) The call actually reached the upstream mock THROUGH the Pinchy proxy
    // with the correct, connection-scoped token — proves OpenClaw ->
    // /api/internal/mcp-proxy/<id> -> mock with the injected real token (the
    // mock only accepts "rotation-token-v1" from this point on; a wrong/
    // missing token would 401 and never reach handleToolCall's call log).
    const calls = await getMcpMockCalls();
    expect(calls.some((c) => c.tool === "create_issue")).toBe(true);

    // (3) Governance proof, sibling of #605's built-in allowlist guard but at
    // the MCP layer: OpenClaw must advertise ONLY the granted tool to the
    // model — never the two ungranted tools that exist on the very same
    // connection.
    const seenRes = await fetch(
      `http://localhost:${FAKE_OLLAMA_PORT}/__pinchy_fake_ollama/tools-seen`
    );
    const seen = ((await seenRes.json()) as { tools: string[] }).tools;
    expect(seen).toContain(createIssueToolName);
    expect(seen).not.toContain(nativeMcpToolName(connectionId, "list_repos"));
    expect(seen).not.toContain(nativeMcpToolName(connectionId, "legacy_search"));

    // (4) Live proof of T7's dynamic per-connection skill (D2): the skill's
    // frontmatter `name` (mcpSkillId(connectionId)) — the exact string
    // OpenClaw's skill-eligibility filter matches against
    // agents.list[].skills, and what its <available_skills> prompt block
    // renders verbatim — must appear in the actual request payload OpenClaw
    // sent the model for this dispatch. T7 could only verify (by reading
    // OpenClaw's bundled dist) that this SHOULD happen; this is the live
    // confirmation that it does.
    //
    // What this does NOT prove: the skill's full BODY (Capabilities list,
    // Safety block, etc.) landing in the model's context. OpenClaw's skill
    // delivery is progressive disclosure — only each skill's name/
    // description/file location is inlined into the prompt; the body is
    // loaded on demand via the `read` tool only if the model decides the
    // task matches the description (verified by reading the same pinned
    // dist T7 used: skill-version-*.js's formatSkillsForPrompt). The fake
    // LLM here is a scripted trigger-responder, not a reasoning model, so it
    // never exercises that on-demand load — asserting full-body delivery
    // isn't observable through this round trip without a materially
    // different (and much less deterministic) fake LLM.
    const lastReqRes = await fetch(
      `http://localhost:${FAKE_OLLAMA_PORT}/__pinchy_fake_ollama/last-request-text`
    );
    const lastReqText = ((await lastReqRes.json()) as { text: string }).text;
    expect(lastReqText).toContain(mcpSkillId(connectionId));
  });

  test("rotating the connection's token takes effect on the next dispatch, with no OpenClaw restart", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(220_000);

    // The mock now rejects the OLD token — this is a sanity check that the
    // gate below is real (if the proxy kept sending the old token, the
    // dispatch would 401 at the mock and never reach the call log).
    await requireMcpMockToken("rotation-token-v2");
    await clearMcpMockCalls();

    // Rotate the connection's stored token via PATCH. Per T6, a token-only
    // edit does NOT call regenerateOpenClawConfig() — MCP's credential proxy
    // decrypts the connection's row fresh on every proxied request (T4: "the
    // proxy reads it per request and revalidates it"), so nothing in
    // openclaw.json changes on rotation and no hot-reload is needed. If the
    // very next dispatch below still reaches the mock, that can only be
    // because the proxy never cached the old token in the first place — not
    // because this test forced any kind of reload.
    const patchRes = await pinchyPatch(
      `/api/integrations/${connectionId}`,
      { credentials: { token: "rotation-token-v2" } },
      cookie
    );
    expect(patchRes.status).toBe(200);

    const since = new Date().toISOString();
    const trigger = "MCP_PROXY_DISPATCH_PROBE_2";
    const reg = await fetch(`http://localhost:${FAKE_OLLAMA_PORT}/control/tool-trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger,
        toolName: createIssueToolName,
        arguments: { title: "E2E issue 2", repo: "pinchy" },
      }),
    });
    expect(reg.ok).toBe(true);

    // Fresh page fixture per test — re-authenticate before driving the chat UI.
    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${trigger}: please create another issue`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: createIssueToolName,
      agentId,
      since,
      deadlineMs: 160_000,
    });
    expect(dispatched).toBe(true);

    // Definitive signal: the mock's call log only fills from INSIDE its
    // auth gate (see config/mcp-mock/server.js) — a call landing here means
    // the proxy authenticated with "rotation-token-v2", the value the PATCH
    // above just wrote, with no restart and no explicit regenerate call from
    // this test in between.
    const calls = await getMcpMockCalls();
    expect(calls.some((c) => c.tool === "create_issue")).toBe(true);
  });
});
