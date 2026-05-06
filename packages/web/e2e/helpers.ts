import { expect, type Page, type APIRequestContext } from "@playwright/test";

const TEST_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test";

export async function seedProviderConfig() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(TEST_DB_URL);
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('default_provider', 'anthropic', false)
    ON CONFLICT (key) DO UPDATE SET value = 'anthropic'
  `;
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('anthropic_api_key', 'sk-ant-fake-key', false)
    ON CONFLICT (key) DO UPDATE SET value = 'sk-ant-fake-key', encrypted = false
  `;
  await sql.end();
}

export const ADMIN_USER = {
  email: "admin@test.local",
  password: "test-password-123",
} as const;

export async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(ADMIN_USER.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_USER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
}

export const SECOND_USER = {
  name: "Second User",
  email: "second@test.local",
  password: "second-password-123",
} as const;

/**
 * Creates a second user via the invite + claim API flow.
 * Assumes admin session is present in `request` (pass `page.context().request`).
 * Requires a clean test database — will throw if the email is already registered.
 * Returns the user email.
 */
export async function createSecondUserViaInvite(
  request: APIRequestContext,
  opts: { email?: string; role?: "admin" | "member" } = {}
): Promise<{ email: string }> {
  const email = opts.email ?? SECOND_USER.email;
  const role = opts.role ?? "member";

  const inviteRes = await request.post("/api/users/invite", {
    data: { email, role },
  });
  if (!inviteRes.ok()) {
    throw new Error(`Invite failed: ${inviteRes.status()} ${await inviteRes.text()}`);
  }
  const { token } = await inviteRes.json();

  const claimRes = await request.post("/api/invite/claim", {
    data: { token, name: SECOND_USER.name, password: SECOND_USER.password },
  });
  if (!claimRes.ok()) {
    throw new Error(`Claim failed: ${claimRes.status()} ${await claimRes.text()}`);
  }

  return { email };
}

/**
 * Logs in via the UI as a specific user.
 */
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(chat|settings|agents)/);
}

/**
 * Logs out the current session via the sidebar "Log out" button.
 */
export async function logout(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("button", { name: /log out/i }).click();
  await page.waitForURL(/\/login/);
}

/**
 * Forcefully clears all session cookies on the page's browser context.
 * Use this before `loginAs` when switching users in a test that previously
 * had a different user logged in — `loginAs` alone does not always replace
 * the existing session cookie, and the UI-based `logout` helper requires the
 * current session to still be valid (the "Log out" button only renders on
 * authenticated pages).
 */
export async function clearSession(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Switch the current page's session to a different user via the auth API
 * directly — no UI form interaction. This is deterministic and avoids the
 * UI race conditions that affect the form-based loginAs (form state caching
 * across goto, hydration timing, Better Auth's signIn not always replacing
 * an existing session cookie).
 *
 * After this call, page.context() (and thus page.request and any subsequent
 * page.goto) uses the target user's session cookie.
 */
export async function switchUser(page: Page, email: string, password: string): Promise<void> {
  // Clear existing cookies so the Set-Cookie from sign-in becomes the only
  // session cookie in the jar.
  await page.context().clearCookies();
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok()) {
    throw new Error(`switchUser failed: ${res.status()} ${await res.text()}`);
  }
}
