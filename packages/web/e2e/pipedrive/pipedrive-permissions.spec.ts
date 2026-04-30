import { test, expect, type Page } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForPipedriveMock,
  resetPipedriveMock,
  login,
  createPipedriveConnection,
  deleteAllConnections,
  pinchyGet,
  pinchyPost,
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
    { name: "Pipedrive Permissions Test Agent", templateId: "custom" },
    cookie
  );
  if (!createRes.ok) {
    throw new Error(`Failed to create shared agent: ${createRes.status}`);
  }
  const agent = await createRes.json();
  return agent.id;
}

test.describe.serial("Pipedrive Permission Setup", () => {
  let cookie: string;
  let connectionId: string;
  let agentId: string;

  test.beforeAll(async () => {
    await seedSetup();
    await waitForPinchy();
    await waitForPipedriveMock();
    await resetPipedriveMock();
    cookie = await login();

    // Clean slate: remove any leftover connections
    await deleteAllConnections(cookie);

    // Create a fresh Pipedrive connection
    const connRes = await createPipedriveConnection(cookie, "Permissions Test Pipedrive");
    expect(connRes.status).toBe(201);
    const conn = await connRes.json();
    connectionId = conn.id;

    // API-based creation does not auto-sync (unlike the wizard). Explicitly
    // trigger a sync and assert that entities were captured, since the UI
    // tests below rely on `connection.data.entities` being populated to show
    // the "Add entity..." button.
    const syncRes = await pinchyPost(`/api/integrations/${connectionId}/sync`, {}, cookie);
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.success).toBe(true);
    expect(syncBody.entities).toBeGreaterThan(0);

    // Sanity-check: the connection row in the DB now carries entity data.
    const integrationsRes = await pinchyGet("/api/integrations", cookie);
    expect(integrationsRes.status).toBe(200);
    const integrations = await integrationsRes.json();
    const storedConn = integrations.find((c: { id: string }) => c.id === connectionId);
    expect(storedConn).toBeTruthy();
    expect(storedConn.data?.entities?.length ?? 0).toBeGreaterThan(0);

    // Ensure we have a shared (non-personal) agent
    agentId = await ensureSharedAgent(cookie);
  });

  test("Pipedrive section is visible when connection exists", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);

    // The Pipedrive heading should be visible
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // The connection dropdown should be present
    const pipedriveSection = page
      .locator("section", { has: page.getByRole("heading", { name: "Pipedrive" }) })
      .first();
    await expect(pipedriveSection.getByRole("combobox")).toBeVisible();
    await expect(pipedriveSection.getByText("Select a connection...")).toBeVisible();
  });

  test("select connection and set access level", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // Open connection dropdown and select the test connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Pipedrive/i }).click();

    // Radio buttons should appear
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Read & Write" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Full" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Custom" })).toBeVisible();

    // Read-only is the default
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // "Add entity..." button should be visible
    await expect(page.getByRole("button", { name: /add entity/i })).toBeVisible();
  });

  test("add an entity and verify checkboxes", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Pipedrive/i }).click();

    // Verify Read-only is selected
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // Click "Add entity..."
    await page.getByRole("button", { name: /add entity/i }).click();

    // Popover opens with a search input
    const searchInput = page.getByPlaceholder("Search entities...");
    await expect(searchInput).toBeVisible();

    // Select "Deals" from the CRM category
    await searchInput.fill("Deals");
    await page
      .getByRole("option", { name: /^Deals/i })
      .first()
      .click();

    // Entity should now appear in the table (exact: true avoids matching "Deals" display name)
    await expect(page.getByText("deals", { exact: true })).toBeVisible();

    // At Read-only: Read checkbox should be checked
    const readCheckbox = page.getByRole("checkbox", { name: /read deals/i });
    await expect(readCheckbox).toBeChecked();

    // Create, Update, Delete should be unchecked at Read-only level
    const createCheckbox = page.getByRole("checkbox", { name: /create deals/i });
    const updateCheckbox = page.getByRole("checkbox", { name: /update deals/i });
    const deleteCheckbox = page.getByRole("checkbox", { name: /delete deals/i });

    await expect(createCheckbox).not.toBeChecked();
    await expect(updateCheckbox).not.toBeChecked();
    await expect(deleteCheckbox).not.toBeChecked();
  });

  test("change access level updates existing entities", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Pipedrive/i }).click();

    // Confirm Read-only default
    await expect(page.getByRole("radio", { name: "Read-only" })).toBeChecked();

    // Add an entity at Read-only
    await page.getByRole("button", { name: /add entity/i }).click();
    await page.getByPlaceholder("Search entities...").fill("Deals");
    await page
      .getByRole("option", { name: /^Deals/i })
      .first()
      .click();

    // Verify only Read is checked
    await expect(page.getByRole("checkbox", { name: /read deals/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /create deals/i })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /update deals/i })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /delete deals/i })).not.toBeChecked();

    // Switch to "Read & Write"
    await page.getByRole("radio", { name: "Read & Write" }).click();

    // Now Read, Create, Update should be checked; Delete still unchecked
    await expect(page.getByRole("checkbox", { name: /read deals/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /create deals/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /update deals/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /delete deals/i })).not.toBeChecked();
  });

  test("remove an entity", async ({ page }) => {
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Pipedrive/i }).click();

    // Add an entity
    await page.getByRole("button", { name: /add entity/i }).click();
    await page.getByPlaceholder("Search entities...").fill("Deals");
    await page
      .getByRole("option", { name: /^Deals/i })
      .first()
      .click();

    // Verify entity is in the table (exact: true avoids matching "Deals" display name)
    await expect(page.getByText("deals", { exact: true })).toBeVisible();

    // Click the remove button (X) for this entity
    await page.getByRole("button", { name: /remove deals/i }).click();

    // Entity should disappear
    await expect(page.getByText("deals", { exact: true })).not.toBeVisible();
  });

  test("save and reload preserves state", async ({ page }) => {
    test.setTimeout(120000);
    await loginViaUI(page);

    await page.goto(`/chat/${agentId}/settings?tab=permissions`);
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 10000 });

    // Select connection
    await page.getByText("Select a connection...").click();
    await page.getByRole("option", { name: /Permissions Test Pipedrive/i }).click();

    // Switch to "Read & Write" before adding entity
    await page.getByRole("radio", { name: "Read & Write" }).click();

    // Add an entity
    await page.getByRole("button", { name: /add entity/i }).click();
    await page.getByPlaceholder("Search entities...").fill("Persons");
    await page
      .getByRole("option", { name: /^Persons/i })
      .first()
      .click();

    // Verify entity is added (exact: true avoids matching "Persons" display name)
    await expect(page.getByText("persons", { exact: true })).toBeVisible();

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
    await expect(page.getByRole("heading", { name: "Pipedrive" })).toBeVisible({ timeout: 15000 });

    // Connection should still be selected
    await expect(page.getByText("Permissions Test Pipedrive")).toBeVisible({ timeout: 10000 });

    // Access level should be "Read & Write"
    await expect(page.getByRole("radio", { name: "Read & Write" })).toBeChecked();

    // Entity should still be in the table (exact: true avoids matching "Persons" display name)
    await expect(page.getByText("persons", { exact: true })).toBeVisible();
  });
});
