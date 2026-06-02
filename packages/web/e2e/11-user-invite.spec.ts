import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin, createSecondUserViaInvite, loginAs } from "./helpers";

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

    // The page loads the token type up front (#436), so a revoked invite is
    // rejected immediately — no claim form is offered at all.
    await expect(inviteePage.getByText("This link can't be used")).toBeVisible({
      timeout: 10000,
    });
    await expect(inviteePage.getByText(/invalid|expired|revoked|not found/i)).toBeVisible();
    await expect(inviteePage.getByText("You've been invited to Pinchy")).toHaveCount(0);
    await expect(inviteePage.getByLabel("Name")).toHaveCount(0);

    await freshContext.close();
  });

  test("password-reset link renders the reset UI (not the invite UI) and preserves the name", async ({
    page,
    browser,
  }) => {
    // Regression guard for #436: a reset link must render a reset-specific UI
    // with no name field, must not overwrite the user's display name, and must
    // let the user sign in with the new password.
    await loginAsAdmin(page);
    const { email } = await createSecondUserViaInvite(page.context().request, {
      email: "resetme@test.local",
    });

    // Find the freshly-created user's id, then generate a reset link.
    const usersRes = await page.context().request.get("/api/users");
    expect(usersRes.ok()).toBeTruthy();
    const { users } = await usersRes.json();
    const target = users.find((u: { email: string }) => u.email === email);
    expect(target).toBeTruthy();
    const originalName: string = target.name;

    const resetRes = await page.context().request.post(`/api/users/${target.id}/reset`);
    expect(resetRes.ok()).toBeTruthy();
    const { token } = await resetRes.json();
    expect(typeof token).toBe("string");

    // Open the reset link in a fresh context (no session cookies).
    const freshContext = await browser.newContext();
    const resetPage = await freshContext.newPage();
    await resetPage.goto(`/invite/${token}`);

    // Reset-specific UI — NOT the invite copy.
    await expect(resetPage.getByText("Reset your Pinchy password")).toBeVisible({ timeout: 10000 });
    await expect(resetPage.getByText("You've been invited to Pinchy")).toHaveCount(0);
    await expect(resetPage.getByText("Set a new password for your account.")).toBeVisible();

    // No name field is offered during a reset.
    await expect(resetPage.getByLabel("Name")).toHaveCount(0);

    // Set a new password and submit.
    const newPassword = "R3setN3w-Password!";
    await resetPage.getByLabel("Password", { exact: true }).fill(newPassword);
    await resetPage.getByLabel("Confirm password").fill(newPassword);
    await resetPage.getByRole("button", { name: "Reset password" }).click();

    await expect(resetPage.getByText("Password reset!")).toBeVisible({ timeout: 10000 });
    await freshContext.close();

    // The display name was NOT overwritten by the reset.
    const usersAfterRes = await page.context().request.get("/api/users");
    const { users: usersAfter } = await usersAfterRes.json();
    const targetAfter = usersAfter.find((u: { email: string }) => u.email === email);
    expect(targetAfter.name).toBe(originalName);

    // The user can sign in with the new password.
    const loginContext = await browser.newContext();
    const loginPage = await loginContext.newPage();
    await loginAs(loginPage, email, newPassword);
    await loginContext.close();
  });
});
