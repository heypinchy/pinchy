const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const MOCK_ODOO_URL = process.env.MOCK_ODOO_URL || "http://localhost:9002";

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

export async function login(
  email = "admin@pinchy.test",
  password = "testpassword"
): Promise<string> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export async function pinchyPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

export async function pinchyPut(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

export async function pinchyPatch(path: string, body: unknown, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

export async function pinchyDelete(path: string, cookie: string): Promise<Response> {
  return fetch(`${PINCHY_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
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
