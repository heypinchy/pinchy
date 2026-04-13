import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

test.describe("Provider configuration", () => {
  test("shows provider selection on first login", async ({ page }) => {
    // Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Lands on provider setup (generous timeout: scrypt hashing + cold compilation of / and /setup/provider)
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    // Verify provider buttons are visible
    await expect(page.getByRole("button", { name: /anthropic/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /openai/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
  });

  test("shows API key input after selecting provider", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    // Select Anthropic
    await page.getByRole("button", { name: /anthropic/i }).click();

    // API key input should be visible with correct placeholder
    await expect(page.getByPlaceholder(/sk-ant-/i)).toBeVisible();
  });

  test("app loads after provider is configured via DB", async ({ page }) => {
    // Seed provider config directly (simulates completed provider setup)
    await seedProviderConfig();

    // Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for login to complete (scrypt hashing can be slow on CI)
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });

    // Should go straight to app (chat page on desktop), not provider setup
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // Verify Smithers agent is visible in the sidebar
    await expect(page.getByRole("link", { name: /smithers/i })).toBeVisible();
  });
});
