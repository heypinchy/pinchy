import { test, expect, type Page } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  setOdooAuthMode,
  login,
  createOdooConnection,
  pinchyGet,
  pinchyDelete,
  getAdminEmail,
  getAdminPassword,
} from "./helpers";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";

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
    await pinchyDelete(`/api/integrations/${conn.id}`, cookie);
  }
}

test.describe.serial("Odoo auth_failed flow", () => {
  let cookie: string;
  let connectionId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();
    // Clean slate
    await deleteAllConnections(cookie);

    // Create a fresh Odoo connection (auth is OK at this point)
    const connRes = await createOdooConnection(cookie, "Auth-Failed Test Odoo");
    if (connRes.status !== 201) {
      throw new Error(`Failed to create Odoo connection: ${connRes.status}`);
    }
    const conn = await connRes.json();
    connectionId = conn.id;

    // Trigger an initial sync so the card shows "Connected"
    await fetch(`${PINCHY_URL}/api/integrations/${connectionId}/sync`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: PINCHY_URL },
    });
    await new Promise((r) => setTimeout(r, 2000));
  });

  test.afterAll(async () => {
    // Always restore auth mode so other test suites are not affected
    await setOdooAuthMode("ok").catch(() => {});
    await deleteAllConnections(cookie).catch(() => {});
  });

  test("auth_failed: sync failure updates card status and sidebar badge appears", async ({
    page,
  }) => {
    await loginViaUI(page);

    // Navigate to integrations settings
    await page.goto("/settings?tab=integrations");

    // Verify the card is initially Connected
    const integrationsPanel = page.getByRole("tabpanel");
    await expect(integrationsPanel.getByText("Connected")).toBeVisible({ timeout: 10000 });

    // Switch mock to fail mode so the next sync returns auth rejected
    await setOdooAuthMode("fail");

    // Open the card's dropdown and trigger Sync Schema
    const connectionCard = integrationsPanel.locator(".rounded-lg.border.p-4").first();
    await connectionCard.locator("[data-slot='dropdown-menu-trigger']").click();
    await page.getByRole("menuitem", { name: /sync schema/i }).click();

    // The sync hook shows a toast.error on failure
    // Wait for the card status to update to "Authentication failed"
    await expect(integrationsPanel.getByText("Authentication failed")).toBeVisible({
      timeout: 20000,
    });

    // The sidebar "!" badge should appear on the Settings link
    // (useIntegrationHealth polls /api/integrations/health)
    // Force a page reload so the sidebar health badge re-fetches
    await page.reload();
    await page.goto("/settings?tab=integrations");

    const settingsLink = page.getByRole("link", { name: /settings/i });
    const badge = settingsLink.locator('[aria-label^="1 integration"]');
    await expect(badge).toBeVisible({ timeout: 15000 });

    // Restore auth mode so the reconnect can succeed
    await setOdooAuthMode("ok");

    // Open the card dropdown and click "Reconnect"
    const cardAfterFail = integrationsPanel.locator(".rounded-lg.border.p-4").first();
    await cardAfterFail.locator("[data-slot='dropdown-menu-trigger']").click();
    await page.getByRole("menuitem", { name: /reconnect/i }).click();

    // Edit credentials dialog opens
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The auth_failed alert hint should be visible in the dialog
    await expect(dialog.getByText(/current credentials failed authentication/i)).toBeVisible({
      timeout: 5000,
    });

    // Fill in the (valid) API key and submit
    await dialog.getByLabel("API Key").fill("test-api-key");
    await dialog.getByRole("button", { name: /^save$/i }).click();

    // Success toast appears
    await expect(page.getByText("Credentials updated")).toBeVisible({ timeout: 10000 });

    // Dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Trigger a sync to clear auth_failed status in DB and on the card
    await fetch(`${PINCHY_URL}/api/integrations/${connectionId}/sync`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: PINCHY_URL },
    });
    await new Promise((r) => setTimeout(r, 2000));

    // Reload to pick up fresh state
    await page.reload();
    await page.goto("/settings?tab=integrations");

    // Card should show "Connected" again (no auth_failed)
    await expect(integrationsPanel.getByText("Connected")).toBeVisible({ timeout: 15000 });
    await expect(integrationsPanel.getByText("Authentication failed")).not.toBeVisible();

    // Sidebar badge should be gone
    await expect(
      page.getByRole("link", { name: /settings/i }).locator('[aria-label^="1 integration"]')
    ).not.toBeVisible();
  });
});
