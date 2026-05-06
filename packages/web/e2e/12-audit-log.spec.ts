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
    // Heading role disambiguates from the description "Create a new group..."
    // which contains "new group" as a substring.
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "New Group" })
    ).toBeVisible();
    // Scope to dialog: the settings page also has a profile-form "Name" input
    // (kept in DOM via Tabs keepMounted) → strict-mode violation otherwise.
    await page.getByRole("dialog").getByLabel("Name").fill(AUDIT_TEST_GROUP);
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // Poll the audit API until the group.created entry appears.
    // The audit write is deferred via after(), which runs after the response
    // returns. Under CI load the deferred work can take several seconds, so the
    // window is generous (20 × 500ms = 10s). Locally the loop almost always
    // exits on the first or second attempt.
    let entry: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
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

    // The event type badge must be visible. The audit page renders the row in
    // BOTH a mobile card layout (block lg:hidden) and a desktop table (hidden
    // lg:block) — only one is visible at any viewport. .first() picks the
    // mobile DOM node which is hidden under lg+ viewports, so scope to the
    // table to consistently target the visible desktop variant.
    const badge = page.getByRole("table").getByText("group.created").first();
    await expect(badge).toBeVisible({ timeout: 10000 });

    // The audit API does not currently JOIN with `groups`, so the resource
    // cell shows '—' for group resources — the snapshotted name lives in the
    // entry's `detail` JSON, which the UI renders in the per-row detail sheet.
    // Click the row to open the sheet, then assert the group name there.
    await badge.click();
    await expect(page.getByRole("dialog").getByText(AUDIT_TEST_GROUP)).toBeVisible({
      timeout: 10000,
    });
  });

  test("non-admin cannot access the audit log API", async ({ page }) => {
    await loginAs(page, SECOND_USER.email, SECOND_USER.password);

    const res = await page.context().request.get("/api/audit");
    expect(res.status()).toBe(403);
  });
});
