import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

test.describe("User management", () => {
  test.beforeEach(async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("admin can navigate to settings and see users section", async ({ page }) => {
    // Deep-link straight to the Users tab instead of clicking it. The app
    // renders the active tab from the `?tab=` param during SSR (see
    // `useTabParam`'s `initialTab`), so the Users panel is active on first
    // paint. Clicking the tab trigger before hydration silently drops the
    // switch — the panel never activates and the (fetch-gated) Invite User
    // button never appears within the budget. That lost-click race, stacked on
    // the users fetch, was the CI-load flake here. The tab-click path itself
    // stays covered by the next test, which clicks through to the dialog.
    await page.goto("/settings?tab=users");
    // The button lives behind SettingsUsers' `loading` gate, so it renders only
    // after the users fetch resolves. Give that single round-trip the suite's
    // standard 10s render budget — a cold-route JIT compile can eat into 5s.
    await expect(page.getByRole("button", { name: "Invite User" })).toBeVisible({ timeout: 10000 });
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
