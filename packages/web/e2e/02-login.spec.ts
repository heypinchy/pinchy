import { test, expect } from "@playwright/test";

test.describe("Login", () => {
  test("rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("logs in with valid credentials and redirects to provider setup", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // First login after setup → redirected to provider configuration
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 10000 });
  });
});
