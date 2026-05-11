import { test, expect, type Page } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForOdooMock,
  resetOdooMock,
  login,
  createOdooConnection,
  pinchyGet,
  pinchyPost,
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

/** Find an existing shared agent, or create one via API. */
async function ensureSharedAgent(cookie: string): Promise<string> {
  const res = await pinchyGet("/api/agents", cookie);
  if (res.ok) {
    const agents = await res.json();
    const shared = agents.find((a: { isPersonal: boolean }) => !a.isPersonal);
    if (shared) return shared.id;
  }

  // Create a custom shared agent
  const createRes = await pinchyPost(
    "/api/agents",
    { name: "Odoo Permissions Test Agent", templateId: "custom" },
    cookie
  );
  if (!createRes.ok) {
    throw new Error(`Failed to create shared agent: ${createRes.status}`);
  }
  const agent = await createRes.json();
  return agent.id;
}

test.describe.serial("Odoo Permission Setup", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForOdooMock();
    await resetOdooMock();
    cookie = await login();

    // Clean slate: remove any leftover connections
    await deleteAllConnections(cookie);

    // Create a fresh Odoo connection (with synced models)
    const connRes = await createOdooConnection(cookie, "Permissions Test Odoo");
    expect(connRes.status).toBe(201);
    const conn = await connRes.json();
    connectionId = conn.id;

    // Wait for the sync to populate models on the connection.
    // The wizard flow triggers sync automatically, but API creation may need
    // the sync endpoint called explicitly.
    const syncRes = await fetch(`${PINCHY_URL}/api/integrations/${connectionId}/sync`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: PINCHY_URL },
    });
    // Sync may or may not exist — if not, the wizard already synced
    if (syncRes.ok) {
      // Give it a moment to complete
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Ensure we have a shared (non-personal) agent
    agentId = await ensureSharedAgent(cookie);
  });

  test("Odoo section is visible when connection exists", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);

    // The Odoo heading should be visible
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // The connection dropdown should be present
    const odooSection = page
      .locator("section", { has: page.getByRole("heading", { name: "Odoo" }) })
      .first();
    await expect(odooSection.getByRole("combobox")).toBeVisible();
    await expect(odooSection.getByText("Select a connection...")).toBeVisible();
  });

  test("select connection and set access level", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Open connection dropdown and select the test connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Odoo/i }).click();

    // Radio buttons should appear
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Read & Write" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Full" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Custom" })).toBeVisible();

    // Read-only is the default
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // "Add model..." button should be visible
    await expect(page.getByRole("button", { name: /add model/i })).toBeVisible();
  });

  test("add a model and verify checkboxes", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Odoo/i }).click();

    // Verify Read-only is selected
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // Click "Add model..."
    await page.getByRole("button", { name: /add model/i }).click();

    // Popover opens with a search input
    const searchInput = page.getByPlaceholder("Search models...");
    await expect(searchInput).toBeVisible();

    // Select "Orders" from the Sales category (sale.order)
    await searchInput.fill("Orders");
    await page
      .getByRole("option", { name: /^Orders/i })
      .first()
      .click();

    // Model should now appear in the table
    await expect(page.getByText("sale.order")).toBeVisible();

    // At Read-only: Read checkbox should be checked
    const readCheckbox = page.getByRole("checkbox", { name: /read orders/i });
    await expect(readCheckbox).toBeChecked();

    // Create, Write, Delete should be unchecked at Read-only level
    const createCheckbox = page.getByRole("checkbox", { name: /create orders/i });
    const writeCheckbox = page.getByRole("checkbox", { name: /write orders/i });
    const deleteCheckbox = page.getByRole("checkbox", { name: /delete orders/i });

    await expect(createCheckbox).not.toBeChecked();
    await expect(writeCheckbox).not.toBeChecked();
    await expect(deleteCheckbox).not.toBeChecked();
  });

  test("change access level updates existing models", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Odoo/i }).click();

    // Confirm Read-only default
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // Add a model at Read-only
    await page.getByRole("button", { name: /add model/i }).click();
    await page.getByPlaceholder("Search models...").fill("Orders");
    await page
      .getByRole("option", { name: /^Orders/i })
      .first()
      .click();

    // Verify only Read is checked
    await expect(page.getByRole("checkbox", { name: /read orders/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /create orders/i })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /write orders/i })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /delete orders/i })).not.toBeChecked();

    // Switch to "Read & Write"
    await page.getByRole("radio", { name: "Read & Write" }).click();

    // Now Read, Create, Write should be checked; Delete still unchecked
    await expect(page.getByRole("checkbox", { name: /read orders/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /create orders/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /write orders/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /delete orders/i })).not.toBeChecked();
  });

  test("remove a model", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Odoo/i }).click();

    // Add a model
    await page.getByRole("button", { name: /add model/i }).click();
    await page.getByPlaceholder("Search models...").fill("Orders");
    await page
      .getByRole("option", { name: /^Orders/i })
      .first()
      .click();

    // Verify model is in the table
    await expect(page.getByText("sale.order")).toBeVisible();

    // Click the remove button (X) for this model
    await page.getByRole("button", { name: /remove orders/i }).click();

    // Model should disappear
    await expect(page.getByText("sale.order")).not.toBeVisible();
  });

  test("save and reload preserves state", async ({ page }) => {
    test.setTimeout(120000);
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Odoo/i }).click();

    // Switch to "Read & Write" before adding model
    await page.getByRole("radio", { name: "Read & Write" }).click();

    // Add a model
    await page.getByRole("button", { name: /add model/i }).click();
    await page.getByPlaceholder("Search models...").fill("Contacts");
    await page
      .getByRole("option", { name: /^Contacts/i })
      .first()
      .click();

    // Verify model is added
    await expect(page.getByText("res.partner")).toBeVisible();

    // Wait for dirty state to be detected — this is the key indicator
    await expect(page.getByText("Unsaved changes")).toBeVisible({ timeout: 10000 });

    // Remove enterprise badge overlay if present (it blocks button clicks)
    await page.evaluate(() => {
      document.querySelector("[title='Disable enterprise']")?.closest(".fixed")?.remove();
    });

    // Click "Save & Restart" — the button text indicates permissions changed
    await page.getByRole("button", { name: /save/i }).last().click();

    // Confirm in the restart dialog
    const restartDialog = page.getByRole("alertdialog");
    await expect(restartDialog).toBeVisible({ timeout: 5000 });
    await restartDialog.getByRole("button", { name: /save & restart/i }).click();

    // Wait for save to complete
    await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 30000 });

    // Reload the page
    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 15000 });

    // Connection should still be selected
    await expect(page.getByText("Permissions Test Odoo")).toBeVisible({ timeout: 10000 });

    // Access level should be "Read & Write"
    await expect(page.getByRole("radio", { name: "Read & Write" })).toBeChecked();

    // Model should still be in the table
    await expect(page.getByText("res.partner")).toBeVisible();
  });

  // Regression: with an Odoo connection configured, saving any other
  // Permissions change (here: a KB tool) used to falsely re-mark the tab as
  // dirty. The parent's post-save fetchData refetches connections with a new
  // array reference, useOdooPermissions re-runs its load effect, and the
  // resulting onChange propagates up to AgentSettingsPermissions which
  // re-evaluated dirty state against stale mount-time refs.
  test("save clears dirty state and keeps it clear under the Odoo cascade", async ({ page }) => {
    test.setTimeout(120000);
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Odoo" })).toBeVisible({ timeout: 10000 });

    // Toggle a KB tool — its change crosses one of the snapshots that the
    // child component used to freeze at mount.
    await page.getByLabel("List approved directories").click();
    await expect(page.getByText("Unsaved changes")).toBeVisible({ timeout: 10000 });

    // Remove enterprise badge overlay if present (blocks button clicks).
    await page.evaluate(() => {
      document.querySelector("[title='Disable enterprise']")?.closest(".fixed")?.remove();
    });

    // The cascade is triggered by the post-save refetch of /api/integrations.
    // Set up the wait BEFORE the click so we don't miss the response.
    const integrationsRefetch = page.waitForResponse(
      (resp) => resp.url().endsWith("/api/integrations") && resp.request().method() === "GET",
      { timeout: 30000 }
    );

    // Save & Restart.
    await page.getByRole("button", { name: /save/i }).last().click();
    const restartDialog = page.getByRole("alertdialog");
    await expect(restartDialog).toBeVisible({ timeout: 5000 });
    await restartDialog.getByRole("button", { name: /save & restart/i }).click();

    // Save completes — dirty bar reads "All changes saved".
    await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 30000 });

    // Wait for the cascade trigger (connections refetch) to complete; from
    // there React only needs to flush a couple of renders.
    await integrationsRefetch;

    await expect(page.getByText("All changes saved")).toBeVisible();
    await expect(page.getByText("Unsaved changes")).not.toBeVisible();
  });
});
