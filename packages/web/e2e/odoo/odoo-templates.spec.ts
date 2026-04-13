import { test, expect, type Page } from "@playwright/test";
import {
  seedSetup,
  login,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  createOdooConnection,
  getAdminEmail,
  getAdminPassword,
} from "./helpers";

async function loginViaUI(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(getAdminEmail());
  await page.getByLabel("Password", { exact: true }).fill(getAdminPassword());
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
}

test.describe.serial("Odoo Template Creation", () => {
  let cookie: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();

    // Ensure an Odoo connection exists (needed for templates to appear)
    await createOdooConnection(cookie, "Template Test Odoo");
  });

  test("Odoo templates are visible when connection exists", async ({ page }) => {
    await loginViaUI(page);
    await page.goto("/");

    // Click "New Agent"
    await page.getByText(/new agent/i).click();

    // Should see Odoo-related thematic categories.
    // Templates appear as cards (available) or behind a collapsible
    // trigger (unavailable). Either way, the category heading must be visible.
    await expect(page.getByText("Sales & Customers")).toBeVisible({ timeout: 10000 });
  });

  test("all Odoo template categories render in the template selector", async ({ page }) => {
    // Smoke test — ensures Odoo templates surface through /api/templates to
    // the UI. With thematic grouping, unavailable templates appear behind
    // a collapsible trigger per category, so we verify category headings.
    await loginViaUI(page);
    await page.goto("/");
    await page.getByText(/new agent/i).click();

    // Wait for templates to load
    await expect(page.getByText("Sales & Customers")).toBeVisible({ timeout: 10000 });

    // All Odoo-relevant categories should be present (as headings)
    await expect(page.getByText("Finance & Procurement")).toBeVisible();
    await expect(page.getByText("Operations")).toBeVisible();
  });

  test("selecting Odoo template shows connection dropdown", async ({ page }) => {
    await loginViaUI(page);
    await page.goto("/");
    await page.getByText(/new agent/i).click();

    await expect(page.getByText("Sales & Customers")).toBeVisible({ timeout: 10000 });

    // Try to find a directly visible Odoo template card first.
    const odooCard = page
      .locator("[role='button']", {
        has: page.locator("text=/Odoo · /"),
      })
      .first();

    if (await odooCard.isVisible({ timeout: 3000 })) {
      await odooCard.click();

      // Should see agent name input (template detail view loaded)
      await expect(page.getByLabel(/name/i)).toBeVisible({ timeout: 10000 });

      // Should see the Odoo connection section with a select trigger
      await expect(page.locator("[data-slot='select-trigger']").first()).toBeVisible({
        timeout: 5000,
      });
    } else {
      // All Odoo templates are behind a collapsible trigger.
      // The connection exists, so the trigger says "X more with additional
      // Odoo modules" (missing-modules) rather than "Set up connection"
      // (no-connection). Expand and select a template.
      const trigger = page.getByText(/more with additional Odoo modules/).first();
      await expect(trigger).toBeVisible({ timeout: 3000 });
      await trigger.click();

      // Now click the first revealed Odoo template card
      const expandedCard = page
        .locator("[role='button']", {
          has: page.locator("text=/Odoo · /"),
        })
        .first();
      await expect(expandedCard).toBeVisible({ timeout: 3000 });
      await expandedCard.click();

      // Should see agent name input (template detail view loaded)
      await expect(page.getByLabel(/name/i)).toBeVisible({ timeout: 10000 });

      // Should see the Odoo connection section with a select trigger
      await expect(page.locator("[data-slot='select-trigger']").first()).toBeVisible({
        timeout: 5000,
      });
    }
  });
});
