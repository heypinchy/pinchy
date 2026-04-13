import { test, expect } from "@playwright/test";

test.describe("Setup wizard", () => {
  test("creates admin account and shows success", async ({ page }) => {
    // networkidle waits for preflight API call (/api/setup/status) to complete
    // before assertions start — avoids flaky timeouts from cold compilation on CI
    await page.goto("/setup", { waitUntil: "networkidle" });

    // Verify setup page loaded (generous timeout for first page compilation on CI)
    await expect(page.getByText(/welcome to pinchy/i)).toBeVisible({ timeout: 15000 });

    // Fill the form
    await page.getByLabel(/name/i).fill("Test Admin");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByLabel(/confirm password/i).fill("test-password-123");
    await page.getByRole("button", { name: /create account/i }).click();

    // Verify success state (scrypt password hashing can take several seconds)
    await expect(page.getByText(/account created successfully/i)).toBeVisible({ timeout: 15000 });

    // Click continue and verify redirect to login
    await page.getByRole("button", { name: /continue to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("redirects away when setup already complete", async ({ page }) => {
    // Setup was already done in the previous test
    await page.goto("/setup");

    // Should redirect away — setup page is no longer accessible once complete
    await expect(page).not.toHaveURL(/\/setup$/, { timeout: 5000 });
  });
});
