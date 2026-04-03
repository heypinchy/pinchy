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

  test("selecting Odoo template shows connection dropdown", async ({ page }) => {
    await loginViaUI(page);
    await page.goto("/");
    await page.getByText(/new agent/i).click();

    // Wait for Odoo section to load, then click Sales Analyst template
    await expect(page.getByText("Sales Analyst")).toBeVisible({ timeout: 10000 });
    await page.getByText("Sales Analyst").click();

    // Should see connection dropdown (use combobox role to avoid matching multiple "connection" texts)
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });

    // Should see our test connection in the dropdown or auto-selected
    await expect(page.getByText("Template Test Odoo")).toBeVisible({ timeout: 5000 });
  });
});
