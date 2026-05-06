import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  loginAsAdmin,
  loginAs,
  logout,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

/**
 * Knowledge base file editing — web-side coverage only.
 *
 * These tests verify:
 *  1. Admin can write SOUL.md via the UI and the new content is readable back
 *     via the API (file write + API read-back).
 *  2. A non-admin member cannot write to a shared agent's SOUL.md (403
 *     permission boundary).
 *
 * End-to-end "agent answers using uploaded file" is left to the integration
 * test suite (packages/web/e2e/integration/).
 */
test.describe.serial("Knowledge base file editing", () => {
  let agentId: string;

  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();
    const page = await browser.newPage();
    await loginAsAdmin(page);

    // Create second user idempotently — ignore errors if already exists
    await createSecondUserViaInvite(page.context().request).catch(() => {});

    // Find the Smithers agent, or create a fresh one if it doesn't exist yet
    const agentsRes = await page.context().request.get("/api/agents");
    const agents: Array<{ id: string; name: string }> = await agentsRes.json();
    const smithers = agents.find((a) => /smithers/i.test(a.name));

    if (smithers) {
      agentId = smithers.id;
    } else {
      const createRes = await page.context().request.post("/api/agents", {
        data: {
          name: "KB Test Agent",
          templateId: "custom",
          tagline: "Knowledge base E2E test agent",
        },
      });
      if (!createRes.ok()) {
        throw new Error(
          `Failed to create test agent: ${createRes.status()} ${await createRes.text()}`
        );
      }
      const created = await createRes.json();
      agentId = created.id;
    }

    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin edits SOUL.md via UI and new content is readable via API", async ({ page }) => {
    const uniqueContent = `# E2E Test Personality\n\nThis content was written by the E2E test at ${Date.now()}.`;

    // Navigate to the agent's personality settings tab
    await page.goto(`/chat/${agentId}/settings?tab=personality`);

    // Hide the dev-only Enterprise/Community floating badge (DevToolbar) — it
    // sits at fixed bottom-3 right-3 and intercepts pointer events on the Save
    // button which lives in the page's sticky save bar at the same vertical
    // position. The badge is decorative; the test doesn't need to interact
    // with it.
    await page.addStyleTag({
      content: ".fixed.bottom-3.right-3 { display: none !important; }",
    });

    // Wait for the page to finish loading
    await expect(page.getByRole("tab", { name: /personality/i })).toBeVisible({ timeout: 10000 });

    // The SOUL.md editor is inside a collapsible — expand it via the "Customize" trigger
    await page.getByRole("button", { name: /customize/i }).click();

    // The MarkdownEditor renders a <textarea> inside the open collapsible.
    // Scope to [data-state="open"] to avoid matching other MarkdownEditor instances
    // (e.g. the instructions tab which is keepMounted and may also have a textarea in DOM).
    const editor = page.locator('[data-state="open"] textarea');
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.fill(uniqueContent);

    // Click the Save button (no restart needed for personality-only changes)
    await page.getByRole("button", { name: /^save$/i }).click();

    // Wait for the success toast
    await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });

    // Read back via API and verify the content matches
    const fileRes = await page.context().request.get(`/api/agents/${agentId}/files/SOUL.md`);
    expect(fileRes.ok()).toBeTruthy();
    const { content } = await fileRes.json();
    expect(content).toBe(uniqueContent);
  });

  test("non-admin cannot write to a shared agent SOUL.md (403)", async ({ page }) => {
    // Log out the admin session (set by beforeEach), then log in as non-admin
    await logout(page);
    await loginAs(page, SECOND_USER.email, SECOND_USER.password);

    // Attempt to PUT SOUL.md content as the non-admin member
    const putRes = await page.context().request.put(`/api/agents/${agentId}/files/SOUL.md`, {
      data: { content: "Hacked" },
    });

    // Non-admins cannot write shared agent files — expect 403
    expect(putRes.status()).toBe(403);
  });
});
