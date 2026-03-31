import { expect, type Page } from "@playwright/test";

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
