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

export async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("admin@test.local");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
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
  const inviteBody = await inviteRes.json();

  // The invite API returns { token } directly
  let token: string;
  if (inviteBody.token) {
    token = inviteBody.token;
  } else if (inviteBody.inviteLink) {
    // Fallback: parse token from URL /.../invite/TOKEN
    token = inviteBody.inviteLink.split("/invite/").pop()!;
  } else {
    throw new Error(`Unexpected invite response shape: ${JSON.stringify(inviteBody)}`);
  }

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
