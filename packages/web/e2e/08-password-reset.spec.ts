import { test, expect } from "@playwright/test";

test.describe("Password reset page", () => {
  test("/reset/[token] renders the reset form, not the invite form", async ({ page }) => {
    await page.goto("/reset/some-token-value");

    // Reset-specific copy
    await expect(page.getByText("Reset your password")).toBeVisible();
    await expect(page.getByText("Enter a new password for your account.")).toBeVisible();
    await expect(page.getByRole("button", { name: /reset password/i })).toBeVisible();

    // Must NOT render the invite-claim form (that was the bug)
    await expect(page.getByText(/you've been invited to pinchy/i)).toHaveCount(0);
    await expect(page.getByLabel(/^name$/i)).toHaveCount(0);
  });

  test("/invite/[token] still renders the invite form (regression guard)", async ({ page }) => {
    await page.goto("/invite/some-token-value");

    await expect(page.getByText("You've been invited to Pinchy")).toBeVisible();
    await expect(page.getByLabel(/^name$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
  });
});
