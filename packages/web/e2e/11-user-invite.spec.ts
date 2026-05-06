import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

test.describe.serial("User invite flow", () => {
  test.beforeAll(async () => {
    await seedProviderConfig();
  });

  test("admin creates an invite via UI and sees the invite link", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/settings?tab=users");

    // Ensure the Users tab content is loaded
    await expect(page.getByRole("button", { name: "Invite User" })).toBeVisible({ timeout: 10000 });

    // Open invite dialog
    await page.getByRole("button", { name: "Invite User" }).click();

    // Dialog appears
    await expect(page.getByLabel("Email (optional)")).toBeVisible();

    // Fill in email for a new user
    await page.getByLabel("Email (optional)").fill("invitee@test.local");

    // Submit
    await page.getByRole("button", { name: "Create Invite" }).click();

    // After success, an invite link is displayed in the dialog
    await expect(page.getByText(/\/invite\//)).toBeVisible({ timeout: 5000 });
  });

  test("invitee claims the invite and lands on success screen", async ({ page, browser }) => {
    // Use API to create a fresh invite and retrieve the plaintext token
    await loginAsAdmin(page);
    const inviteRes = await page.context().request.post("/api/users/invite", {
      data: { email: "invitee2@test.local", role: "member" },
    });
    expect(inviteRes.ok()).toBeTruthy();
    const { token } = await inviteRes.json();
    expect(typeof token).toBe("string");

    // Open the invite page in a fresh context (no session cookies)
    const freshContext = await browser.newContext();
    const inviteePage = await freshContext.newPage();
    await inviteePage.goto(`/invite/${token}`);

    // Claim form is shown
    await expect(inviteePage.getByText("You've been invited to Pinchy")).toBeVisible({
      timeout: 10000,
    });

    // Fill in the claim form
    await inviteePage.getByLabel("Name").fill("Invitee Two");
    await inviteePage.getByLabel("Password", { exact: true }).fill("Inv1tee-Password!");
    await inviteePage.getByLabel("Confirm password").fill("Inv1tee-Password!");

    // Submit
    await inviteePage.getByRole("button", { name: "Create account" }).click();

    // On success the page shows the account-created confirmation
    await expect(inviteePage.getByText("Account created!")).toBeVisible({ timeout: 10000 });
    await expect(inviteePage.getByRole("button", { name: "Continue to sign in" })).toBeVisible();

    await freshContext.close();
  });

  test("revoked invite cannot be claimed", async ({ page, browser }) => {
    // Create invite via API to get both token and id
    await loginAsAdmin(page);
    const inviteRes = await page.context().request.post("/api/users/invite", {
      data: { email: "revoked@test.local", role: "member" },
    });
    expect(inviteRes.ok()).toBeTruthy();
    const { token, id: inviteId } = await inviteRes.json();
    expect(typeof token).toBe("string");
    expect(typeof inviteId).toBe("string");

    // Revoke the invite
    const deleteRes = await page.context().request.delete(`/api/users/invites/${inviteId}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Try to claim the revoked invite in a fresh context
    const freshContext = await browser.newContext();
    const inviteePage = await freshContext.newPage();
    await inviteePage.goto(`/invite/${token}`);

    // Fill the form and attempt to claim — the server should reject it
    await expect(inviteePage.getByText("You've been invited to Pinchy")).toBeVisible({
      timeout: 10000,
    });
    await inviteePage.getByLabel("Name").fill("Revoked User");
    await inviteePage.getByLabel("Password", { exact: true }).fill("R3voked-Password!");
    await inviteePage.getByLabel("Confirm password").fill("R3voked-Password!");
    await inviteePage.getByRole("button", { name: "Create account" }).click();

    // The page shows an error for the invalid/expired invite
    await expect(inviteePage.getByText(/invalid|expired|revoked|not found/i)).toBeVisible({
      timeout: 5000,
    });

    await freshContext.close();
  });
});
