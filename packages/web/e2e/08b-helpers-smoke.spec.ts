import { test, expect } from "@playwright/test";
import { loginAsAdmin, createSecondUserViaInvite, loginAs, SECOND_USER } from "./helpers";

test("helpers: admin can invite a second user and second user can log in", async ({ page }) => {
  // Login as admin first (admin exists from 01-setup.spec.ts)
  await loginAsAdmin(page);

  // Create second user via invite using the authenticated request context
  const { email } = await createSecondUserViaInvite(page.context().request);
  expect(email).toBe(SECOND_USER.email);

  // Login as second user
  await loginAs(page, SECOND_USER.email, SECOND_USER.password);

  // Second user lands on chat and does NOT see admin-only settings tabs
  await page.goto("/settings");
  // Members never see "Users" tab
  await expect(page.getByRole("tab", { name: /^users$/i })).toHaveCount(0);
});
