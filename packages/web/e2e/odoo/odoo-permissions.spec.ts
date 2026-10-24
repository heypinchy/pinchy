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

    // Trigger a sync to populate models on the connection.
    // The wizard flow triggers sync automatically, but API creation may need
    // the sync endpoint called explicitly. No wait needed after: the sync
    // route (POST /api/integrations/[connectionId]/sync) awaits its DB write
    // of `data.models` before responding, so once the request resolves the
    // models are already committed — there is nothing left to wait for.
    const syncRes = await fetch(`${PINCHY_URL}/api/integrations/${connectionId}/sync`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: PINCHY_URL },
    });
    // A non-ok sync stays tolerated (the wizard may already have synced), but
    // it is the one way the "models are committed" claim above does not hold —
    // so say so instead of letting it surface later as an unexplained empty
    // model list.
    if (!syncRes.ok) {
      console.warn(`[odoo-permissions] explicit sync returned ${String(syncRes.status)}`);
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

  /**
   * The matrix cell is a three-state radiogroup since #1133 (not allowed ·
   * ask first · allowed), so an assertion has to name WHICH state is set
   * rather than checked/unchecked. That is stricter than what it replaced:
   * "not checked" could not tell "not allowed" from "allowed but pausing".
   */
  // Exact string rather than a constructed RegExp: `new RegExp(op)` trips
  // security/detect-non-literal-regexp, and an exact name is the stronger
  // assertion anyway — "read Orders" must not be satisfied by a cell whose
  // label merely contains it.
  const cell = (page: Page, op: string, model = "Orders") =>
    page.getByRole("radiogroup", { name: `${op} ${model}`, exact: true });
  const expectState = (page: Page, op: string, state: RegExp) =>
    expect(cell(page, op).getByRole("radio", { name: state })).toBeChecked();
  const ALLOWED = /^allowed/i;
  const NOT_ALLOWED = /^not allowed/i;

  test("add a model and verify its access states", async ({ page }) => {
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

    // At Read-only: read is granted and ungated, the rest not granted at all.
    await expectState(page, "read", ALLOWED);
    await expectState(page, "create", NOT_ALLOWED);
    await expectState(page, "write", NOT_ALLOWED);
    await expectState(page, "delete", NOT_ALLOWED);
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

    // Verify only Read is granted
    await expectState(page, "read", ALLOWED);
    await expectState(page, "create", NOT_ALLOWED);
    await expectState(page, "write", NOT_ALLOWED);
    await expectState(page, "delete", NOT_ALLOWED);

    // Switch to "Read & Write"
    await page.getByRole("radio", { name: "Read & Write" }).click();

    // Now Read, Create and Write are granted; Delete still is not
    await expectState(page, "read", ALLOWED);
    await expectState(page, "create", ALLOWED);
    await expectState(page, "write", ALLOWED);
    await expectState(page, "delete", NOT_ALLOWED);
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

    // Toggle a workspace tool — its change crosses one of the snapshots that
    // the child component used to freeze at mount. Use "Create files"
    // (pinchy_write): the Knowledge Base section has no toggle left of its own
    // since pinchy_ls/pinchy_read became implicit always-on tools (#384), and
    // this checkbox moved into its own Workspace section when memory became a
    // separate grant. What the test needs is any non-Odoo checkbox whose change
    // propagates through the same onChange — not a Knowledge Base one.
    await page.getByLabel("Create files").click();
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
