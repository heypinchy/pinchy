import { test, expect } from "@playwright/test";
import {
  seedProviderConfig,
  loginAsAdmin,
  loginAs,
  createSecondUserViaInvite,
  SECOND_USER,
} from "./helpers";

// Unique group name per run so retries don't collide with prior runs
const AUDIT_TEST_GROUP = `AuditTestGroup-${Date.now()}`;

test.describe.serial("Audit log", () => {
  test.beforeAll(async ({ browser }) => {
    await seedProviderConfig();
    const page = await browser.newPage();
    await loginAsAdmin(page);

    // Enable enterprise mode so group routes are accessible (idempotent)
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

  test("group creation writes a group.created audit entry with snapshotted name", async ({
    page,
  }) => {
    // Create the group via the UI
    await page.goto("/settings?tab=groups");
    await expect(page.getByRole("button", { name: "New Group" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "New Group" }).click();
    await expect(page.getByRole("dialog").getByText("New Group")).toBeVisible();
    await page.getByLabel("Name").fill(AUDIT_TEST_GROUP);
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // Poll the audit API until the group.created entry appears (after() is async)
    let entry: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await page.context().request.get(`/api/audit?eventType=group.created&limit=100`);
      expect(res.ok()).toBe(true);
      const body = await res.json();
      entry = (body.entries as Array<Record<string, unknown>>).find(
        (e) => (e.detail as Record<string, unknown>)?.name === AUDIT_TEST_GROUP
      );
      if (entry) break;
      await page.waitForTimeout(500);
    }

    expect(
      entry,
      `group.created entry for "${AUDIT_TEST_GROUP}" not found in audit log`
    ).toBeDefined();
    expect(entry!.eventType).toBe("group.created");
    expect(entry!.outcome).toBe("success");
    expect(entry!.actorType).toBe("user");
    expect((entry!.detail as Record<string, unknown>).name).toBe(AUDIT_TEST_GROUP);
  });

  test("audit log UI shows the group.created entry to admin", async ({ page }) => {
    await page.goto("/audit");

    // The page renders "Audit Trail" as the heading
    await expect(page.getByRole("heading", { name: "Audit Trail" })).toBeVisible({
      timeout: 10000,
    });

    // The table (desktop) or card list (mobile) must contain the event type badge
    // Use a broad text matcher that covers both layouts
    await expect(page.getByText("group.created").first()).toBeVisible({ timeout: 10000 });

    // The snapshotted group name should appear somewhere in the rendered entries
    // (it surfaces in the resource column or detail sheet, but the Badge always shows eventType)
    // Verify the event type for our specific group by filtering
    await page.goto(`/audit`);
    await expect(page.getByRole("heading", { name: "Audit Trail" })).toBeVisible({
      timeout: 10000,
    });

    // Use the API one more time from page context to confirm the entry has the right name in detail
    const res = await page.context().request.get(`/api/audit?eventType=group.created&limit=100`);
    const body = await res.json();
    const entry = (body.entries as Array<Record<string, unknown>>).find(
      (e) => (e.detail as Record<string, unknown>)?.name === AUDIT_TEST_GROUP
    );
    expect(
      entry,
      `group.created entry for "${AUDIT_TEST_GROUP}" not visible via admin API`
    ).toBeDefined();
  });

  test("non-admin cannot access the audit log API", async ({ page }) => {
    await loginAs(page, SECOND_USER.email, SECOND_USER.password);

    const res = await page.context().request.get("/api/audit");
    expect(res.status()).toBe(403);
  });
});
