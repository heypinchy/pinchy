import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  loginAsAdmin,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

test.describe.serial("Groups CRUD", () => {
  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();
    const page = await browser.newPage();
    await loginAsAdmin(page);

    // Enable enterprise mode so group routes are accessible (idempotent: only toggle if not already enabled)
    const status = await page.request.get("/api/enterprise/status");
    const statusJson = await status.json();
    if (!statusJson.enterprise) {
      await page.request.post("/api/dev/enterprise-toggle");
    }

    await createSecondUserViaInvite(page.context().request).catch(() => {
      // Idempotent: ignore if already created by an earlier spec
    });

    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("create a group with no description — dialog closes, group appears in list", async ({
    page,
  }) => {
    await page.goto("/settings?tab=groups");

    // Wait for the Groups tab content to load
    await expect(page.getByRole("button", { name: "New Group" })).toBeVisible({ timeout: 10000 });

    // Open create dialog
    await page.getByRole("button", { name: "New Group" }).click();

    // Dialog title appears
    await expect(page.getByRole("dialog").getByText("New Group")).toBeVisible();

    // Fill in name only
    await page.getByLabel("Name").fill("Engineering");

    // Click Create
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

    // Dialog closes
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // Group appears in the table
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Engineering" })).toBeVisible({ timeout: 5000 });
  });

  test("create a group with description and a member — member count shows 1", async ({ page }) => {
    await page.goto("/settings?tab=groups");

    await expect(page.getByRole("button", { name: "New Group" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "New Group" }).click();

    await expect(page.getByRole("dialog").getByText("New Group")).toBeVisible();

    await page.getByLabel("Name").fill("Design");
    await page.getByLabel("Description").fill("Design team");

    // Check the second user's checkbox using aria-label
    await page.getByRole("checkbox", { name: SECOND_USER.name }).click();

    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

    // Dialog closes
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // Group appears; find the Design row and verify member count = 1
    const designRow = page.getByRole("row", { name: /Design/ });
    await expect(designRow).toBeVisible({ timeout: 5000 });
    await expect(designRow.getByRole("cell").nth(2)).toHaveText("1");
  });

  test("edit a group name — new name appears in list", async ({ page }) => {
    await page.goto("/settings?tab=groups");

    await expect(page.getByRole("table")).toBeVisible({ timeout: 10000 });

    // Click Edit on the Engineering row
    const engineeringRow = page.getByRole("row", { name: /Engineering/ });
    await expect(engineeringRow).toBeVisible({ timeout: 5000 });
    await engineeringRow.getByRole("button", { name: "Edit" }).click();

    // Edit dialog opens
    await expect(page.getByRole("dialog").getByText("Edit Group")).toBeVisible();

    // Clear name and type new name
    await page.getByLabel("Name").clear();
    await page.getByLabel("Name").fill("Engineering Updated");

    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();

    // Dialog closes
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // New name appears in table
    await expect(page.getByRole("cell", { name: "Engineering Updated" })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole("cell", { name: "Engineering", exact: true })).not.toBeVisible();
  });

  test("delete a group — group disappears from list", async ({ page }) => {
    await page.goto("/settings?tab=groups");

    await expect(page.getByRole("table")).toBeVisible({ timeout: 10000 });

    // Click Delete on the Design row
    const designRow = page.getByRole("row", { name: /Design/ });
    await expect(designRow).toBeVisible({ timeout: 5000 });
    await designRow.getByRole("button", { name: "Delete" }).click();

    // Confirmation dialog appears
    await expect(page.getByRole("alertdialog").getByText("Delete Group")).toBeVisible();

    // Confirm deletion
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

    // Group disappears from table
    await expect(page.getByRole("row", { name: /Design/ })).not.toBeVisible({ timeout: 5000 });
  });

  test("API returns 400 — UI shows error toast and dialog stays open", async ({ page }) => {
    await page.goto("/settings?tab=groups");

    await expect(page.getByRole("button", { name: "New Group" })).toBeVisible({ timeout: 10000 });

    // Intercept POST /api/groups to return a 400 error
    await page.route("/api/groups", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Validation failed" }),
        });
      } else {
        await route.continue();
      }
    });

    // Open create dialog
    await page.getByRole("button", { name: "New Group" }).click();
    await expect(page.getByRole("dialog").getByText("New Group")).toBeVisible();

    // Fill in name
    await page.getByLabel("Name").fill("Bad Group");

    // Click Create
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

    // Toast error with "Validation failed" should appear
    await expect(page.getByText("Validation failed")).toBeVisible({ timeout: 5000 });

    // Dialog must still be open
    await expect(page.getByRole("dialog").getByText("New Group")).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
  });
});
