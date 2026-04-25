import { test, expect, type Page } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  pinchyGet,
  pinchyDelete,
  login,
  createOdooConnection,
  getAdminEmail,
  getAdminPassword,
} from "./helpers";

// The URL the Pinchy container uses to reach the Odoo mock inside Docker
const ODOO_INTERNAL_URL = "http://odoo-mock:8069";

async function loginViaUI(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(getAdminEmail());
  await page.getByLabel("Password", { exact: true }).fill(getAdminPassword());
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
}

async function deleteAllConnections(cookie: string) {
  const res = await pinchyGet("/api/integrations", cookie);
  if (!res.ok) return;
  const connections = await res.json();
  for (const conn of connections) {
    await pinchyDelete(`/api/integrations/${conn.id}/with-permissions`, cookie);
  }
}

test.describe.serial("Odoo Wizard Flow", () => {
  let cookie: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();
    // Clean up any leftover connections from previous test runs
    await deleteAllConnections(cookie);
  });

  test("happy path: add Odoo integration via wizard", async ({ page }) => {
    await loginViaUI(page);

    // Navigate to integrations tab
    await page.goto("/settings?tab=integrations");

    // Click "Add Integration"
    await page.getByRole("button", { name: /add integration/i }).click();

    // Dialog opens — select Odoo type
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Odoo/ }).click();

    // Step 1: Connect — fill credentials
    await expect(dialog.getByText(/step 1 of 3/i)).toBeVisible();

    await dialog.getByLabel("URL").fill(ODOO_INTERNAL_URL);
    // Trigger blur so DB detection fires (it will fail, showing the manual DB input)
    await dialog.getByLabel("URL").blur();

    await dialog.getByLabel("Email").fill("admin");
    await dialog.getByLabel("API Key").fill("test-api-key");

    // Wait for the DB field to appear (after URL blur, detection fails, manual input shows)
    const dbField = dialog.getByLabel("Database");
    await expect(dbField).toBeVisible({ timeout: 10000 });
    await dbField.fill("testdb");

    // Click Connect — this tests credentials AND syncs schema
    await dialog.getByRole("button", { name: "Connect" }).click();

    // Step 2: Sync preview — wait for sync results (categories with accessible models)
    // The step indicator shows "Step 2 of 3" but we wait for actual content
    await expect(dialog.getByText("Sales")).toBeVisible({ timeout: 30000 });

    // Click Continue to proceed to name step
    await dialog.getByRole("button", { name: "Continue" }).click();

    // Step 3: Name & Save
    await expect(dialog.getByText(/step 3 of 3/i)).toBeVisible({ timeout: 10000 });

    // A name should be auto-generated
    const nameInput = dialog.getByLabel(/name this integration/i);
    await expect(nameInput).toBeVisible();
    const autoName = await nameInput.inputValue();
    expect(autoName.length).toBeGreaterThan(0);

    // Click Save
    await dialog.getByRole("button", { name: "Save" }).click();

    // Dialog closes and integration appears in the list
    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(autoName)).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();
  });

  test("bad credentials show error", async ({ page }) => {
    await loginViaUI(page);

    await page.goto("/settings?tab=integrations");

    await page.getByRole("button", { name: /add integration/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Odoo/ }).click();

    // Fill with wrong API key
    await dialog.getByLabel("URL").fill(ODOO_INTERNAL_URL);
    await dialog.getByLabel("URL").blur();

    await dialog.getByLabel("Email").fill("admin");
    await dialog.getByLabel("API Key").fill("wrong-api-key");

    const dbField = dialog.getByLabel("Database");
    await expect(dbField).toBeVisible({ timeout: 10000 });
    await dbField.fill("testdb");

    await dialog.getByRole("button", { name: "Connect" }).click();

    // Should show an error message (inline form error)
    await expect(dialog.getByText(/connection test failed|authentication/i)).toBeVisible({
      timeout: 15000,
    });

    // Dialog should still be open (user can correct and retry)
    await expect(dialog).toBeVisible();
  });

  test("delete connection", async ({ page }) => {
    // Ensure there is at least one connection (created in the happy path test)
    const listRes = await pinchyGet("/api/integrations", cookie);
    const connections = await listRes.json();
    if (connections.length === 0) {
      // Create one via API as fallback
      await createOdooConnection(cookie, "Delete Test Odoo");
    }

    await loginViaUI(page);
    await page.goto("/settings?tab=integrations");

    // Wait for the connection to appear in the list
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 10000 });

    // Get the connection name before deletion for later assertion
    const connectionCard = page.locator(".rounded-lg.border.p-4").first();
    const connectionName = await connectionCard.locator(".font-medium").first().textContent();

    // Open the dropdown menu (three dots)
    await connectionCard
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .click();

    // Click Delete in the dropdown
    await page.getByRole("menuitem", { name: /delete/i }).click();

    // Confirm in the alert dialog (waits past the loading phase)
    const alertDialog = page.getByRole("alertdialog");
    await expect(alertDialog).toBeVisible();
    await expect(alertDialog.getByText(/cannot be undone/i)).toBeVisible({ timeout: 10000 });
    await alertDialog.getByRole("button", { name: /^delete$/i }).click();

    // Connection disappears — either the list is empty or the name is gone
    if (connectionName) {
      await expect(page.getByText(connectionName)).not.toBeVisible({ timeout: 10000 });
    }
    await expect(alertDialog).not.toBeVisible();
  });
});
