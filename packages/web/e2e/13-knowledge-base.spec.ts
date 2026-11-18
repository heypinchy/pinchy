import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  apiSignInAsAdmin,
  loginAsAdmin,
  switchUser,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

/**
 * Knowledge base file editing — web-side coverage only.
 *
 * These tests verify:
 *  1. Admin can write SOUL.md via the UI and the new content is readable back
 *     via the API (file write + API read-back).
 *  2. A non-admin member is refused that same file, with an answer that does
 *     not reveal whether the agent exists.
 *
 * Item 2 was described as the shared-agent WRITE boundary and asserted 403. It
 * never tested that: `beforeAll` prefers the admin's Smithers, which is a
 * PERSONAL agent, so the member is stopped by the READ gate long before any
 * write check is reached — and that 403 was precisely the existence disclosure
 * `getAgentWithAccess` now closes. The shared-agent write boundary is covered
 * deterministically in `src/__tests__/api/agent-files.test.ts`.
 *
 * End-to-end "agent answers using uploaded file" is left to the integration
 * test suite (packages/web/e2e/integration/).
 */
test.describe.serial("Knowledge base file editing", () => {
  let agentId: string;

  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();

    // Pure data-setup hook — only uses the request context, never the page UI.
    // Authenticate over the API (not the UI `loginAsAdmin`, which waits up to
    // 15 s for hydration) so the hook stays inside its 30 s budget under CI
    // load. See `apiSignIn`.
    const context = await browser.newContext();
    const request = context.request;
    await apiSignInAsAdmin(request);

    // Create second user idempotently — ignore errors if already exists
    await createSecondUserViaInvite(request).catch(() => {});

    // Find the Smithers agent, or create a fresh one if it doesn't exist yet
    const agentsRes = await request.get("/api/agents");
    const agents: Array<{ id: string; name: string }> = await agentsRes.json();
    const smithers = agents.find((a) => /smithers/i.test(a.name));

    if (smithers) {
      agentId = smithers.id;
    } else {
      const createRes = await request.post("/api/agents", {
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

    await context.close();
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

  test("a non-admin is refused SOUL.md on an agent they cannot see — 404, not 403", async ({
    page,
  }) => {
    // Anchor the assertion before switching users: beforeEach left this page
    // logged in as the admin, who can read the agent, so it demonstrably
    // exists. Without this the 404 below is also what a mistyped id returns,
    // and the test would pass against a route that had stopped working.
    const adminRes = await page.context().request.get(`/api/agents/${agentId}`);
    expect(
      adminRes.status(),
      `Agent ${agentId} must exist — otherwise the member's 404 proves nothing`
    ).toBe(200);

    // Switch from admin (set by beforeEach) to the non-admin via the auth API
    // directly. UI-based loginAs has racy form-state interactions when chained
    // after a prior login on the same page; switchUser is deterministic.
    await switchUser(page, SECOND_USER.email, SECOND_USER.password);

    // Attempt to PUT SOUL.md content as the non-admin member
    const putRes = await page.context().request.put(`/api/agents/${agentId}/files/SOUL.md`, {
      data: { content: "Hacked" },
    });

    // The read gate answers before the write gate, and it withholds the agent's
    // existence. This holds for either branch of beforeAll: the admin's
    // personal Smithers (the preferred one) is invisible to a non-owner, and a
    // freshly created agent sits at the DB default `restricted` visibility with
    // the member in no group.
    expect(putRes.status()).toBe(404);
    expect(await putRes.json()).toEqual({ error: "Agent not found" });
  });
});
