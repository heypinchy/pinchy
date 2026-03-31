import { test, expect } from "@playwright/test";

const TEST_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test";

async function seedProviderConfig() {
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

async function loginAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("admin@test.local");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
}

test.describe("User management", () => {
  test.beforeEach(async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("admin can navigate to settings and see users section", async ({ page }) => {
    await page.goto("/settings");
    // Navigate to Users tab (default tab is Context)
    await page.getByRole("tab", { name: /users/i }).click();
    // Settings page loads and shows Invite User button (admin-only feature)
    await expect(page.getByRole("button", { name: "Invite User" })).toBeVisible({ timeout: 5000 });
  });

  test("admin can invite a new user and see the invite link", async ({ page }) => {
    await page.goto("/settings");

    // Navigate to Users tab
    await page.getByRole("tab", { name: /users/i }).click();

    // Open invite dialog
    await page.getByRole("button", { name: "Invite User" }).click();

    // Dialog appears — check for the email input which is unique to the dialog
    await expect(page.getByLabel("Email (optional)")).toBeVisible();

    // Fill email (optional)
    await page.getByLabel("Email (optional)").fill("newuser@test.com");

    // Submit
    await page.getByRole("button", { name: "Create Invite" }).click();

    // After success, an invite link is displayed
    await expect(page.getByText(/\/invite\//)).toBeVisible({ timeout: 5000 });
  });
});
