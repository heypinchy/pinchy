import { test, expect, type Page } from "@playwright/test";
import { AGENT_TEMPLATES } from "../../src/lib/agent-templates";
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
    // Depending on which models the mock exposes, templates may render as
    // individual cards (available) or as a teaser ("X templates available
    // with Odoo"). Either way, the category heading must be visible.
    await expect(page.getByText("Sales & Customers")).toBeVisible({ timeout: 10000 });
  });

  test("all Odoo template categories render in the template selector", async ({ page }) => {
    // Smoke test — ensures Odoo templates surface through /api/templates to
    // the UI, either as cards or as teasers. With thematic grouping,
    // unavailable templates appear in a teaser line per category rather than
    // as individual cards, so we verify category headings instead of template
    // names.
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

    // Find an available Odoo template card to click.
    // HR Analyst requires only hr.employee + hr.department — if the mock
    // doesn't expose them, fall back to any visible Odoo template card.
    // The mock exposes sale.order/res.partner/product.product, so look for
    // any clickable Odoo template that might be available.
    await expect(page.getByText("Sales & Customers")).toBeVisible({ timeout: 10000 });

    // Click any Odoo template that appears as a card (not in a teaser).
    // Use the first card with an Odoo badge as indicator.
    const odooCard = page.locator("[role='button']", {
      has: page.locator("text=/Odoo · /"),
    }).first();

    // If no Odoo card is available (all teasers), click the teaser link
    // to verify it navigates correctly
    if (await odooCard.isVisible({ timeout: 3000 })) {
      await odooCard.click();

      // Should see agent name input (template detail view loaded)
      await expect(page.getByLabel(/name/i)).toBeVisible({ timeout: 10000 });

      // Should see the Odoo connection section with a select trigger
      await expect(page.locator("[data-slot='select-trigger']").first()).toBeVisible({
        timeout: 5000,
      });
    } else {
      // All Odoo templates are unavailable — verify teaser link exists
      await expect(page.getByText(/templates available with Odoo/)).toBeVisible();
      await expect(page.getByText(/Set up connection/)).toBeVisible();
    }
  });
});
