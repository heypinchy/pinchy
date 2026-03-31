import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

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
