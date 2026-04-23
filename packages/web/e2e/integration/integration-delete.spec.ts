// packages/web/e2e/integration/integration-delete.spec.ts
//
// Full E2E flow: create an integration, grant an agent permission on it,
// verify "Used by 1 agent" label, open the delete dialog, and confirm
// "Detach & Delete" removes the integration.
//
// Runs against the integration Docker stack (http://localhost:7779).
// Admin account is seeded by global-setup.ts.

import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@integration.local";
const ADMIN_PASSWORD = "integration-password-123";
const INTEGRATION_NAME = "E2E Odoo";

test("admin can detach-and-delete an integration used by agents", async ({ page }) => {
  let connectionId: string | null = null;
  let agentId: string | null = null;

  // Login via the UI (page carries the session cookie for subsequent requests)
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

  try {
    // 1. Create integration via API using the page's authenticated session
    const createIntegration = await page.request.post("/api/integrations", {
      data: {
        type: "odoo",
        name: INTEGRATION_NAME,
        description: "E2E test integration — created by integration-delete.spec.ts",
        credentials: {
          url: "http://odoo-mock:8069",
          db: "testdb",
          login: "admin",
          apiKey: "test-api-key",
          uid: 2,
        },
      },
    });
    expect(createIntegration.status()).toBe(201);
    const integration = await createIntegration.json();
    connectionId = integration.id as string;

    // 2. Create a custom agent via API
    const createAgent = await page.request.post("/api/agents", {
      data: {
        name: "E2E Delete Test Agent",
        templateId: "custom",
      },
    });
    expect(createAgent.status()).toBe(201);
    const agent = await createAgent.json();
    agentId = agent.id as string;

    // 3. Grant the agent a permission on the integration
    const grantPermission = await page.request.put(`/api/agents/${agentId}/integrations`, {
      data: {
        connectionId,
        permissions: [{ model: "sale.order", operation: "read" }],
      },
    });
    expect(grantPermission.status()).toBe(200);

    // 4. Navigate to integrations settings and reload to see the updated count
    await page.goto("/settings?tab=integrations");
    await expect(page.getByText(new RegExp(INTEGRATION_NAME, "i"))).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText(/used by 1 agent/i)).toBeVisible();

    // 5. Open the integration's action menu and click Delete
    //    Each integration row has a MoreHorizontal dropdown trigger.
    //    The integration row containing INTEGRATION_NAME is the one we want.
    const integrationRow = page
      .locator("div")
      .filter({ hasText: INTEGRATION_NAME })
      .filter({
        has: page.getByRole("button", { name: /open menu/i }),
      });
    await integrationRow.getByRole("button", { name: /open menu/i }).click();
    await page.getByRole("menuitem", { name: /delete/i }).click();

    // 6. Dialog shows "Delete E2E Odoo?" heading and "Detach & Delete" button
    //    (phase === "detach" because the integration has 1 agent permission)
    await expect(
      page.getByRole("heading", { name: new RegExp(`delete ${INTEGRATION_NAME}`, "i") })
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /detach & delete/i })).toBeVisible();

    // 7. Click "Detach & Delete"
    await page.getByRole("button", { name: /detach & delete/i }).click();

    // 8. Integration row is gone from the listing.
    //    Use the same row locator (with "open menu" button filter) to avoid
    //    matching the deletion toast which also contains the integration name.
    await expect(integrationRow).not.toBeVisible({ timeout: 10000 });

    // Mark as cleaned up — no need to delete in afterAll
    connectionId = null;
  } finally {
    // Cleanup: remove agent and (if not already deleted) the integration
    if (agentId) {
      await page.request.delete(`/api/agents/${agentId}`).catch(() => {
        // Best-effort: agent may already be gone or endpoint may not exist
      });
    }
    if (connectionId) {
      // Integration was not deleted by the test (failure path) — clean up via
      // the with-permissions endpoint so FK constraints don't block deletion
      await page.request
        .delete(`/api/integrations/${connectionId}/with-permissions`)
        .catch(async () => {
          await page.request.delete(`/api/integrations/${connectionId}`).catch(() => undefined);
        });
    }
  }
});
