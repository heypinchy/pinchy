import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  loginAsAdmin,
  loginAs,
  clearSession,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

/**
 * Personal agent visibility boundary.
 *
 * Personal agents (isPersonal: true) are private to their owner.
 * The visibility rule in visible-agents.ts applies regardless of role:
 * even admins cannot see another user's personal agent.
 *
 * This spec verifies:
 * 1. Admin's Smithers (personal) is NOT visible to SECOND_USER
 * 2. SECOND_USER's Smithers (personal) is NOT visible to admin
 *
 * Both Smithers agents are seeded automatically:
 * - Admin's: by seedDefaultAgent() during the setup wizard (isPersonal: true)
 * - Second user's: by seedPersonalAgent() during invite claim (isPersonal: true)
 */
test.describe.serial("Agent visibility — personal vs shared", () => {
  let adminSmithersId: string;
  let secondUserSmithersId: string;

  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();
    const page = await browser.newPage();
    await loginAsAdmin(page);

    // Create second user via invite (idempotent: catch if already exists)
    await createSecondUserViaInvite(page.context().request).catch(() => {});

    // Resolve the admin's personal Smithers ID
    const agentsRes = await page.context().request.get("/api/agents");
    expect(agentsRes.ok()).toBeTruthy();
    const adminAgents = await agentsRes.json();
    const adminSmithers = (
      adminAgents as Array<{ id: string; isPersonal: boolean; name: string }>
    ).find((a) => a.isPersonal);
    if (!adminSmithers) throw new Error("Admin's personal Smithers not found in /api/agents");
    adminSmithersId = adminSmithers.id;

    await page.close();

    // Log in as second user to resolve their personal Smithers ID
    const secondPage = await browser.newPage();
    await loginAs(secondPage, SECOND_USER.email, SECOND_USER.password);
    const secondAgentsRes = await secondPage.context().request.get("/api/agents");
    expect(secondAgentsRes.ok()).toBeTruthy();
    const secondAgents = await secondAgentsRes.json();
    const secondSmithers = (
      secondAgents as Array<{ id: string; isPersonal: boolean; name: string }>
    ).find((a) => a.isPersonal);
    if (!secondSmithers)
      throw new Error("Second user's personal Smithers not found in /api/agents");
    secondUserSmithersId = secondSmithers.id;

    await secondPage.close();
  });

  test("admin's personal agent is not visible to a different user", async ({ page }) => {
    // Verify: admin sees their own Smithers via /api/agents
    await loginAsAdmin(page);
    const adminAgentsRes = await page.context().request.get("/api/agents");
    const adminAgents = await adminAgentsRes.json();
    const adminSeesOwn = (adminAgents as Array<{ id: string }>).some(
      (a) => a.id === adminSmithersId
    );
    expect(adminSeesOwn).toBe(true);

    // Switch to second user and verify admin's Smithers is absent
    await clearSession(page);
    await loginAs(page, SECOND_USER.email, SECOND_USER.password);

    // API: admin's Smithers must not appear in SECOND_USER's agent list
    const secondAgentsRes = await page.context().request.get("/api/agents");
    const secondAgents = await secondAgentsRes.json();
    const secondSeesAdminsSmithers = (secondAgents as Array<{ id: string }>).some(
      (a) => a.id === adminSmithersId
    );
    expect(secondSeesAdminsSmithers).toBe(false);

    // Direct fetch of the agent resource must return 403 (Forbidden).
    // Accepting 404 here would mask a regression where the privacy check
    // silently degrades to a not-found path. Match the second test exactly.
    const directRes = await page.context().request.get(`/api/agents/${adminSmithersId}`);
    expect(directRes.status()).toBe(403);

    // Sidebar: admin's Smithers link must not be present
    // Both users have a Smithers agent, so we check by agentId in the href
    // /chat is not a route on its own — only /chat/[agentId]. Use /agents
    // which redirects to /chat/<first-visible-agent> on desktop, ensuring the
    // app layout (and the sidebar) is rendered.
    await page.goto("/agents");
    const adminSmithersLink = page.locator(`a[href*="${adminSmithersId}"]`);
    await expect(adminSmithersLink).not.toBeVisible({ timeout: 10000 });
  });

  test("user's personal agent is not visible to admin", async ({ page }) => {
    // Verify: second user sees their own Smithers via /api/agents
    await loginAs(page, SECOND_USER.email, SECOND_USER.password);
    const secondAgentsRes = await page.context().request.get("/api/agents");
    const secondAgents = await secondAgentsRes.json();
    const secondSeesOwn = (secondAgents as Array<{ id: string }>).some(
      (a) => a.id === secondUserSmithersId
    );
    expect(secondSeesOwn).toBe(true);

    // Switch to admin and verify second user's Smithers is absent
    await clearSession(page);
    await loginAsAdmin(page);

    // API: second user's Smithers must not appear in admin's agent list
    const adminAgentsRes = await page.context().request.get("/api/agents");
    const adminAgents = await adminAgentsRes.json();
    const adminSeesSecondSmithers = (adminAgents as Array<{ id: string }>).some(
      (a) => a.id === secondUserSmithersId
    );
    expect(adminSeesSecondSmithers).toBe(false);

    // Direct fetch should also return 403 (not just absent from list)
    const directRes = await page.context().request.get(`/api/agents/${secondUserSmithersId}`);
    expect(directRes.status()).toBe(403);

    // UI: second user's Smithers link must not be present in admin's sidebar
    // /chat is not a route on its own — only /chat/[agentId]. Use /agents
    // which redirects to /chat/<first-visible-agent> on desktop, ensuring the
    // app layout (and the sidebar) is rendered.
    await page.goto("/agents");
    const secondSmithersLink = page.locator(`a[href*="${secondUserSmithersId}"]`);
    await expect(secondSmithersLink).not.toBeVisible({ timeout: 10000 });
  });
});
