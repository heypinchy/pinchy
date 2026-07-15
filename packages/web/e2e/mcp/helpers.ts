// packages/web/e2e/mcp/helpers.ts
//
// Shared setup/request helpers for the MCP E2E suite, following the pattern
// established by e2e/odoo/helpers.ts and e2e/email helpers: a thin fetch
// wrapper (not the UI) drives the admin REST flow, and loginViaUI (from
// ../shared/dispatch-probe) is reserved for the one test that needs a real
// browser session to drive the chat UI.

import { stackDbUrl } from "../shared/stack-db";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_MCP_URL = process.env.MOCK_MCP_URL || "http://localhost:9007";

// Admin credentials — set by seedSetup, used by login and loginViaUI
let _adminEmail = "admin@test.local";
const _adminPassword = "test-password-123";

export function getAdminEmail(): string {
  return _adminEmail;
}

export function getAdminPassword(): string {
  return _adminPassword;
}

/**
 * Seed the initial admin account and provider config in DB.
 * Mirrors the Odoo/email E2E seedSetup pattern.
 */
export async function seedSetup(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  const existing = await sql`SELECT id, email FROM "user" LIMIT 1`;
  if (existing.length > 0) {
    _adminEmail = existing[0].email;
    await sql.end();
    console.log(`[mcp-setup] Using existing admin: ${_adminEmail}`);
    return;
  }

  const setupRes = await fetch(`${PINCHY_URL}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    body: JSON.stringify({
      name: "Test Admin",
      email: _adminEmail,
      password: _adminPassword,
    }),
  });

  if (!setupRes.ok) {
    const text = await setupRes.text();
    await sql.end();
    throw new Error(`Setup failed: ${setupRes.status} ${text}`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  // Seed a provider so agents can be created (the round-trip describe block
  // later swaps this to ollama-local via seedDefaultProviderToOllama).
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
  console.log(`[mcp-setup] Admin created: ${_adminEmail}`);
}

export async function waitForPinchy(timeout = 60_000): Promise<void> {
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

export async function waitForMcpMock(timeout = 30_000): Promise<void> {
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

export async function resetMcpMock(): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to reset MCP mock: ${res.status}`);
}

export async function toggleMcpMockTool(tool: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/toggle-tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, enabled }),
  });
  if (!res.ok) throw new Error(`Failed to toggle tool ${tool}: ${res.status}`);
}

/**
 * Gate the mock's MCP JSON-RPC endpoint behind a specific bearer token (or,
 * with `token: null`, drop the gate back to accept-any). Used by the
 * token-rotation scenario to prove the credential proxy injects the CURRENT
 * decrypted token on every request, not a stale/cached one.
 */
export async function requireMcpMockToken(token: string | null): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/require-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`Failed to set required token: ${res.status}`);
}

export async function clearMcpMockCalls(): Promise<void> {
  const res = await fetch(`${MOCK_MCP_URL}/control/clear-calls`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to clear MCP mock calls: ${res.status}`);
}

export interface McpMockCall {
  tool: string;
  args: Record<string, unknown>;
  calledAt: string;
}

export async function getMcpMockCalls(): Promise<McpMockCall[]> {
  const res = await fetch(`${MOCK_MCP_URL}/control/calls`);
  if (!res.ok) throw new Error(`Failed to get MCP mock calls: ${res.status}`);
  return res.json();
}

export async function login(email = _adminEmail, password = _adminPassword): Promise<string> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PINCHY_URL,
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Login failed — no set-cookie header (status ${res.status})`);
  }
  return setCookie;
}

export async function pinchyGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "GET",
    headers: { Cookie: cookie },
  });
}

// Issue #235: state-changing requests must declare a same-origin source so
// the CSRF gate accepts them. Cookie-only auth would otherwise be CSRF-able.
function mutatingHeaders(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: PINCHY_URL,
  };
}

export async function pinchyPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

export async function pinchyPut(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PUT",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

export async function pinchyPatch(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PATCH",
    headers: mutatingHeaders(cookie),
    body: JSON.stringify(body),
  });
}

/**
 * The mcp-mock URL from inside the Docker network (container-to-container).
 * Pinchy talks to the mock through the internal Docker network using the
 * service name `mcp-mock`, while tests talk to it through the host-exposed
 * port 9007. The integration credentials (and, for discovery/sync, Pinchy's
 * own outbound calls) must use the internal URL.
 */
export const MCP_MOCK_INTERNAL_URL = "http://mcp-mock:9007/";

export async function createMcpConnection(
  cookie: string,
  opts: { name?: string; token?: string } = {}
): Promise<Response> {
  return pinchyPost(
    "/api/integrations",
    {
      type: "mcp",
      name: opts.name ?? "Test MCP",
      description: "Mock MCP server for testing",
      preset: "generic",
      transport: "http",
      url: MCP_MOCK_INTERNAL_URL,
      token: opts.token ?? "test-token",
    },
    cookie
  );
}

export async function setAgentMcpPermissions(
  cookie: string,
  agentId: string,
  connectionId: string,
  toolNames: string[]
): Promise<Response> {
  return pinchyPut(
    `/api/agents/${agentId}/integrations`,
    {
      connectionId,
      permissions: toolNames.map((operation) => ({ model: "mcp", operation })),
    },
    cookie
  );
}
