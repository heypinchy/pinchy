import { test, expect } from "@playwright/test";

test.describe("Setup wizard", () => {
  test("creates admin account and shows success", async ({ page }) => {
    await page.goto("/setup");

    // Verify setup page loaded
    await expect(page.getByText(/welcome to pinchy/i)).toBeVisible();

    // Fill the form
    await page.getByLabel(/name/i).fill("Test Admin");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /create account/i }).click();

    // Verify success state
    await expect(page.getByText(/account created successfully/i)).toBeVisible();

    // Click continue and verify redirect to login
    await page.getByRole("button", { name: /continue to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("shows error when setup already complete", async ({ page }) => {
    // Setup was already done in the previous test
    await page.goto("/setup");

    await page.getByLabel(/name/i).fill("Second User");
    await page.getByLabel(/email/i).fill("second@test.local");
    await page.getByLabel(/password/i).fill("test-password-123");
    await page.getByRole("button", { name: /create account/i }).click();

    // Should show error (setup already complete)
    await expect(page.getByText(/already/i)).toBeVisible();
  });
});
