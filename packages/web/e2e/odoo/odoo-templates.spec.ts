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

    // Should see the Odoo section
    await expect(page.getByText("Odoo")).toBeVisible({ timeout: 10000 });

    // Should see at least Sales Analyst template
    await expect(page.getByText("Sales Analyst")).toBeVisible();
  });

  test("all 16 Odoo templates render in the template selector", async ({ page }) => {
    // Smoke test — ensures every template from AGENT_TEMPLATES surfaces through
    // /api/templates to the UI. Dimmed/unavailable templates still render, so
    // this test doesn't depend on the mock exposing every model.
    await loginViaUI(page);
    await page.goto("/");
    await page.getByText(/new agent/i).click();
    await expect(page.getByText("Sales Analyst")).toBeVisible({ timeout: 10000 });

    const expectedTemplates = [
      // Original 6
      "Sales Analyst",
      "Inventory Scout",
      "Finance Controller",
      "CRM & Sales Assistant",
      "Procurement Agent",
      "Customer Service",
      // 10 new templates
      "HR Analyst",
      "Project Tracker",
      "Manufacturing Planner",
      "Recruitment Coordinator",
      "Subscription Manager",
      "POS Analyst",
      "Marketing Analyst",
      "Expense Auditor",
      "Fleet Manager",
      "Website Analyst",
    ];

    for (const name of expectedTemplates) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
  });

  test("selecting Odoo template shows connection dropdown", async ({ page }) => {
    await loginViaUI(page);
    await page.goto("/");
    await page.getByText(/new agent/i).click();

    // Wait for Odoo section to load, then click Sales Analyst template
    await expect(page.getByText("Sales Analyst")).toBeVisible({ timeout: 10000 });
    await page.getByText("Sales Analyst").click();

    // Should see agent name input (template detail view loaded)
    await expect(page.getByLabel(/name/i)).toBeVisible({ timeout: 10000 });

    // Should see the Odoo connection section with a select trigger
    await expect(page.locator("[data-slot='select-trigger']").first()).toBeVisible({
      timeout: 5000,
    });
  });
});
