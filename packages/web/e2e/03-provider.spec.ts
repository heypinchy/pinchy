import { test, expect } from "@playwright/test";

const TEST_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test";

test.describe("Provider configuration", () => {
  test("shows provider selection on first login", async ({ page }) => {
    // Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Lands on provider setup
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 10000 });

    // Verify provider buttons are visible
    await expect(page.getByRole("button", { name: /anthropic/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /openai/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  });

  test("shows API key input after selecting provider", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 10000 });

    // Select Anthropic
    await page.getByRole("button", { name: /anthropic/i }).click();

    // API key input should be visible with correct placeholder
    await expect(page.getByPlaceholder(/sk-ant-/i)).toBeVisible();
  });

  test("app loads after provider is configured via DB", async ({ page }) => {
    // Seed provider config directly (simulates completed provider setup)
    const { default: postgres } = await import("postgres");
    const sql = postgres(TEST_DB_URL);
    await sql`
      INSERT INTO settings (key, value, encrypted)
      VALUES ('default_provider', 'anthropic', false)
      ON CONFLICT (key) DO UPDATE SET value = 'anthropic'
    `;
    await sql`
      INSERT INTO settings (key, value, encrypted)
      VALUES ('anthropic_api_key', 'sk-ant-fake-key', true)
      ON CONFLICT (key) DO UPDATE SET value = 'sk-ant-fake-key'
    `;
    await sql.end();

    // Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should go straight to app (chat page), not provider setup
    await expect(page).toHaveURL(/\/chat\//, { timeout: 10000 });

    // Verify Smithers agent is visible in sidebar
    await expect(page.getByRole("link", { name: /smithers/i })).toBeVisible();
  });
});
