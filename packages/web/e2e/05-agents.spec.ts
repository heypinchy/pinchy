import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin, apiSignInAsAdmin } from "./helpers";

test.describe("Agent management", () => {
  test.beforeAll(async ({ browser }) => {
    // The E2E server runs Next in dev mode, which compiles a page on its first
    // request. /agents/new measured 4.1s (next.js: 3.9s, application-code:
    // 45ms) on a loaded runner, blowing the 5s URL assertion below. Pay that
    // compile once here, untimed and signed in (the proxy redirects an
    // anonymous request to /login before the page is compiled).
    await seedProviderConfig();
    const context = await browser.newContext();
    await apiSignInAsAdmin(context.request);
    await context.request.get("/agents/new");
    await context.close();
  });

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
