import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

test.describe("Agent management", () => {
  test.beforeEach(async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("Smithers agent is visible in sidebar after login", async ({ page }) => {
    await expect(page.getByRole("link", { name: /smithers/i })).toBeVisible();
  });

  test("new agent form is reachable and renders template selection", async ({ page }) => {
    // Click "New Agent" to navigate to the create form
    await page.getByRole("link", { name: /new agent/i }).click();

    await expect(page).toHaveURL(/\/agents\/new/, { timeout: 5000 });

    // Template selection is shown.
    // The "Knowledge Base" template creates agents that use pinchy-files for
    // scoped read-only access to a directory of documents.
    await expect(page.getByText(/start from scratch/i)).toBeVisible();
    await expect(page.getByText(/knowledge base/i)).toBeVisible(); // exercises pinchy-files
  });

  test("new agent form shows name input after selecting template", async ({ page }) => {
    await page.getByRole("link", { name: /new agent/i }).click();
    await expect(page).toHaveURL(/\/agents\/new/, { timeout: 5000 });

    // Select Custom Agent template via "start from scratch" link
    await page.getByText(/start from scratch/i).click();

    // Name input and Create button are visible
    await expect(page.getByLabel(/name/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create/i })).toBeVisible();
  });
});
