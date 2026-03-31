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

test.describe("Agent management", () => {
  test.beforeEach(async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("Smithers agent is visible in sidebar after login", async ({ page }) => {
    await expect(page.getByRole("link", { name: /smithers/i })).toBeVisible();
  });

  test("creates a new agent and shows it in the sidebar", async ({ page }) => {
    // Click "New Agent" to navigate to the create form
    await page.getByRole("link", { name: /new agent/i }).click();

    // Select Custom Agent template
    await page.getByText(/custom agent/i).click();

    // Fill in agent name
    await page.getByLabel(/name/i).fill("Test Bot");

    // Submit
    await page.getByRole("button", { name: /create/i }).click();

    // After creation, should be on the new agent's chat page
    await expect(page).toHaveURL(/\/chat\//, { timeout: 10000 });

    // New agent appears in sidebar
    await expect(page.getByRole("link", { name: /test bot/i })).toBeVisible();
  });
});
