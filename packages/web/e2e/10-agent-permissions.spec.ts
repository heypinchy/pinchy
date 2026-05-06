import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  loginAsAdmin,
  switchUser,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

test.describe.serial("Agent permissions — restricted visibility", () => {
  let agentId: string;
  let groupId: string;
  let secondUserId: string;

  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();
    const page = await browser.newPage();
    await loginAsAdmin(page);

    // Enable enterprise mode (same pattern as 09-groups.spec.ts)
    const status = await page.request.get("/api/enterprise/status");
    const { enterprise } = await status.json();
    if (!enterprise) {
      await page.request.post("/api/dev/enterprise-toggle");
    }

    // Create second user (idempotent: ignore if already exists)
    await createSecondUserViaInvite(page.context().request).catch(() => {});

    // Resolve second user's ID from the users list
    const usersRes = await page.context().request.get("/api/users");
    const { users } = await usersRes.json();
    const secondUser = users.find(
      (u: { email: string; id: string }) => u.email === SECOND_USER.email
    );
    if (!secondUser) throw new Error("Second user not found after invite");
    secondUserId = secondUser.id;

    // Create a group with no members yet
    const groupRes = await page.context().request.post("/api/groups", {
      data: { name: "Restricted Group", description: null },
    });
    const groupData = await groupRes.json();
    if (!groupRes.ok()) {
      throw new Error(`Failed to create group: ${JSON.stringify(groupData)}`);
    }
    groupId = groupData.id;

    // Create an agent using the "custom" template (no extra config required).
    // Note: the DB default for visibility is "restricted", so we explicitly PATCH to "all" below.
    const agentRes = await page.context().request.post("/api/agents", {
      data: {
        name: "Permissions Test Agent",
        templateId: "custom",
        tagline: "E2E permissions test agent",
      },
    });
    const agentData = await agentRes.json();
    if (!agentRes.ok()) {
      throw new Error(`Failed to create agent: ${JSON.stringify(agentData)}`);
    }
    agentId = agentData.id;

    // Set initial visibility to "all" so tests 1+2 can verify non-admin access
    const patchRes = await page.context().request.patch(`/api/agents/${agentId}`, {
      data: { visibility: "all" },
    });
    if (!patchRes.ok()) {
      throw new Error(
        `Failed to set agent visibility: ${patchRes.status()} ${await patchRes.text()}`
      );
    }

    await page.close();
  });

  test("admin sees the agent (visibility: all)", async ({ page }) => {
    await loginAsAdmin(page);

    // API precheck: the agent must be in admin's /api/agents response.
    // This separates "the agent isn't visible to admin" from "selector wrong".
    const adminAgents = await page.context().request.get("/api/agents");
    expect(adminAgents.ok()).toBeTruthy();
    const list = (await adminAgents.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === agentId)).toBe(true);

    // UI: match by href so we don't depend on accessible-name composition
    // (the link's a11y name includes both agent.name and tagline).
    await page.goto("/agents");
    await expect(page.locator(`a[href*="${agentId}"]`)).toBeVisible({ timeout: 10000 });
  });

  test("non-admin sees the agent while visibility is all", async ({ page }) => {
    // beforeEach logged the admin in; switch to the non-admin via a clean
    // logout first so Better Auth issues a fresh session cookie for the new
    // user (sign-in alone does not always invalidate the existing cookie).
    await switchUser(page, SECOND_USER.email, SECOND_USER.password);

    const memberAgents = await page.context().request.get("/api/agents");
    expect(memberAgents.ok()).toBeTruthy();
    const list = (await memberAgents.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === agentId)).toBe(true);

    await page.goto("/agents");
    await expect(page.locator(`a[href*="${agentId}"]`)).toBeVisible({ timeout: 10000 });
  });

  test("admin restricts agent to a group the non-admin is NOT in", async ({ page }) => {
    await loginAsAdmin(page);

    // PATCH agent: set visibility to "restricted" and assign the group (non-admin is not a member)
    const patchRes = await page.request.patch(`/api/agents/${agentId}`, {
      data: {
        visibility: "restricted",
        groupIds: [groupId],
      },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Admin still sees the agent (admins bypass visibility filtering)
    await page.goto("/agents");
    await expect(page.locator(`a[href*="${agentId}"]`)).toBeVisible({ timeout: 10000 });
  });

  test("non-admin no longer sees the restricted agent", async ({ page }) => {
    // Switch to the non-admin via a clean logout first so the prior admin
    // session cookie (set by beforeEach) is fully cleared. Without this, the
    // sign-in API call sometimes does not replace the existing session and
    // the SSR layout re-fetches with admin's role.
    await switchUser(page, SECOND_USER.email, SECOND_USER.password);

    // API-level assertion first: verify the server agrees the agent is hidden
    // from this user. If this fails, it's a server-side visibility bug rather
    // than a client/UI rendering issue, and the next assertion just confirms
    // the contract holds end-to-end.
    const memberAgents = await page.context().request.get("/api/agents");
    expect(memberAgents.ok()).toBeTruthy();
    const list = (await memberAgents.json()) as Array<{ id: string }>;
    expect(
      list.some((a) => a.id === agentId),
      `Restricted agent ${agentId} unexpectedly visible to non-member via /api/agents`
    ).toBe(false);

    // UI: the link must also not appear in the sidebar.
    await page.goto("/agents");
    await expect(page.locator(`a[href*="${agentId}"]`)).not.toBeVisible({ timeout: 10000 });
  });

  test("admin adds non-admin to the group; non-admin sees agent again", async ({ page }) => {
    await loginAsAdmin(page);

    // Add second user to the restricted group via PUT /api/groups/:groupId/members
    const membersRes = await page.request.put(`/api/groups/${groupId}/members`, {
      data: { userIds: [secondUserId] },
    });
    expect(membersRes.ok()).toBeTruthy();

    // Now switch to second user with a clean logout (avoids session leakage
    // from beforeEach's admin login) and verify the agent reappears.
    await switchUser(page, SECOND_USER.email, SECOND_USER.password);
    await page.goto("/agents");

    await expect(page.locator(`a[href*="${agentId}"]`)).toBeVisible({ timeout: 10000 });
  });
});
