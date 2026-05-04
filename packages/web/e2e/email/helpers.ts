import { createCipheriv, randomBytes } from "crypto";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";
const GMAIL_MOCK_URL = process.env.GMAIL_MOCK_URL || "http://localhost:9004";

// Admin credentials — set by seedSetup, used by login
let _adminEmail = "admin@test.local";
const _adminPassword = "test-password-123";

export function getAdminEmail(): string {
  return _adminEmail;
}

export function getAdminPassword(): string {
  return _adminPassword;
}

/**
 * Encrypt a plaintext string using AES-256-GCM, matching Pinchy's encryption format.
 * Required for seeding Google OAuth credentials directly into the DB.
 */
function encryptCredentials(plaintext: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey || encKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(encKey)) {
    throw new Error("ENCRYPTION_KEY must be set to 64 hex characters for E2E tests");
  }
  const key = Buffer.from(encKey, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Seed the initial admin account and provider config in DB.
 * Mirrors the web E2E seedSetup pattern.
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
    console.log(`[email-setup] Using existing admin: ${_adminEmail}`);
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
  console.log(`[email-setup] Admin created: ${_adminEmail}`);
}

/**
 * Create a Google (Gmail) connection directly in the DB, bypassing the OAuth flow.
 * This is necessary because Google OAuth requires browser redirects and real Google
 * credentials — both unavailable in automated E2E tests.
 *
 * The seeded credentials include an accessToken that matches the mock's expectations
 * and an already-expired expiresAt to verify the token refresh flow on first use.
 */
export async function createGoogleConnectionInDb(
  name = "Test Gmail"
): Promise<{ id: string; type: string; name: string }> {
  const dbUrl = process.env.DATABASE_URL || "postgresql://pinchy:pinchy_dev@localhost:5434/pinchy";
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);

  const credentials = {
    accessToken: "mock-initial-access-token",
    refreshToken: "mock-refresh-token",
    // Expired in the past so the credentials route will trigger a token refresh
    // against the gmail-mock's /token endpoint
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    scope: "https://www.googleapis.com/auth/gmail.modify",
  };

  const encryptedCredentials = encryptCredentials(JSON.stringify(credentials));

  const [row] = await sql`
    INSERT INTO integration_connections (type, name, description, credentials, status)
    VALUES ('google', ${name}, 'Test Gmail connection for E2E', ${encryptedCredentials}, 'active')
    RETURNING id, type, name
  `;

  await sql.end();
  return row as { id: string; type: string; name: string };
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

export async function waitForGmailMock(timeout = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${GMAIL_MOCK_URL}/control/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Gmail mock not ready after ${timeout}ms`);
}

export async function resetGmailMock(): Promise<void> {
  const res = await fetch(`${GMAIL_MOCK_URL}/control/reset`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to reset Gmail mock: ${res.status}`);
}

export async function getSentMessages(): Promise<Array<{ raw: string; sentAt: string }>> {
  const res = await fetch(`${GMAIL_MOCK_URL}/control/sent`);
  if (!res.ok) throw new Error(`Failed to get sent messages: ${res.status}`);
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

/**
 * Poll /api/health/openclaw until `connected` is true or the timeout elapses.
 * Returns true if connected within the timeout, false otherwise.
 */
export async function waitForOpenClawConnected(cookie: string, timeout = 60000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await pinchyGet("/api/health/openclaw", cookie);
      if (res.ok) {
        const body = (await res.json()) as { connected?: boolean };
        if (body.connected) return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
