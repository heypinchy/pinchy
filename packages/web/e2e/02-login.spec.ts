import { test, expect } from "@playwright/test";

test.describe("Login", () => {
  test("rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("logs in with valid credentials and redirects to provider setup", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // First login after setup → redirected to provider configuration
    // (generous timeout: scrypt hashing + cold compilation of / and /setup/provider on CI)
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    // Signed in, /login asks instead of showing the form again: continue as
    // this account, or sign out and sign in as someone else.
    await page.goto("/login");
    await expect(page.getByText(/you're already signed in/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toHaveCount(0);
    await page.getByRole("link", { name: /continue/i }).click();
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    await page.goto("/login");
    await page.getByRole("button", { name: /sign in as someone else/i }).click();
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 20000 });
  });
});
