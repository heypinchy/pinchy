const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

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
 * Mirrors the Telegram E2E seedSetup pattern.
 */
export async function seedSetup(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  // Check if setup already done
  const existing = await sql`SELECT id, email FROM "user" LIMIT 1`;
  if (existing.length > 0) {
    _adminEmail = existing[0].email;
    await sql.end();
    console.log(`[odoo-setup] Using existing admin: ${_adminEmail}`);
    return;
  }

  // Create admin via Pinchy's setup API
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

  // Seed provider config (needed for agent creation)
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
  console.log(`[odoo-setup] Admin created: ${_adminEmail}`);
}

export async function resetOdooMock(): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/reset`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to reset Odoo mock: ${res.status}`);
}

export async function seedOdooRecords(
  model: string,
  records: Record<string, unknown>[]
): Promise<void> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, records }),
  });
  if (!res.ok) throw new Error(`Failed to seed Odoo records: ${res.status}`);
}

export async function getOdooRecords(model: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${MOCK_ODOO_URL}/control/records?model=${encodeURIComponent(model)}`);
  if (!res.ok) throw new Error(`Failed to get Odoo records: ${res.status}`);
  return res.json();
}

export async function waitForOdooMock(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${MOCK_ODOO_URL}/control/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Odoo mock not ready after ${timeout}ms`);
}

export async function waitForPinchy(timeout = 30000): Promise<void> {
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

export async function pinchyDelete(path: string, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: PINCHY_URL },
  });
}

export async function createOdooConnection(cookie: string, name = "Test Odoo"): Promise<Response> {
  return pinchyPost(
    "/api/integrations",
    {
      type: "odoo",
      name,
      description: "Mock Odoo for testing",
      credentials: {
        url: "http://odoo-mock:8069",
        db: "testdb",
        login: "admin",
        apiKey: "test-api-key",
        uid: 2,
      },
    },
    cookie
  );
}

export async function setAgentPermissions(
  cookie: string,
  agentId: string,
  connectionId: string,
  permissions: Array<{ model: string; operation: string }>
): Promise<Response> {
  return pinchyPut(`/api/agents/${agentId}/integrations`, { connectionId, permissions }, cookie);
}
