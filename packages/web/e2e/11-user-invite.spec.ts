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
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();

    // Fill in email for a new user
    await page.getByLabel("Email", { exact: true }).fill("invitee@test.local");

    // Submit
    await page.getByRole("button", { name: "Create Invite" }).click();

    // After success, an invite link is displayed in the dialog
    await expect(page.getByText(/\/invite\//)).toBeVisible({ timeout: 5000 });
    // ...with the reminder that Pinchy doesn't deliver it, and its expiry (#1265).
    await expect(
      page.getByText(
        "Pinchy doesn't send emails. Copy the link and send it to invitee@test.local yourself."
      )
    ).toBeVisible();
    await expect(page.getByText(/The link works once and expires on /)).toBeVisible();
  });

  test("invitee claims the invite and is signed in right away", async ({ page, browser }) => {
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

    // Claim form is shown, naming the inviter and the sign-in address (#1265)
    await expect(inviteePage.getByText(/invited you to Pinchy$/)).toBeVisible({
      timeout: 10000,
    });
    await expect(inviteePage.getByLabel("Email", { exact: true })).toHaveValue(
      "invitee2@test.local"
    );
    await expect(inviteePage.getByLabel("Confirm password")).toHaveCount(0);

    // Fill in the claim form
    await inviteePage.getByLabel("Name").fill("Invitee Two");
    await inviteePage.getByLabel("Password", { exact: true }).fill("Inv1tee-Password!");

    // Submit
    await inviteePage.getByRole("button", { name: "Create account" }).click();

    // The page signs the new account in and leaves for the app — no second
    // trip through /login.
    await expect(inviteePage).not.toHaveURL(/\/(invite|login)(\/|$)/, { timeout: 15000 });
    const sessionRes = await inviteePage.request.get("/api/auth/get-session");
    expect(sessionRes.ok()).toBeTruthy();
    expect((await sessionRes.json())?.user?.email).toBe("invitee2@test.local");

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
    await expect(inviteePage.getByText(/invited you to Pinchy/)).toHaveCount(0);
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
    await expect(resetPage.getByText(/invited you to Pinchy/)).toHaveCount(0);
    await expect(resetPage.getByText("Set a new password for your account.")).toBeVisible();

    // No name field is offered during a reset.
    await expect(resetPage.getByLabel("Name")).toHaveCount(0);

    // Set a new password and submit.
    const newPassword = "R3setN3w-Password!";
    await resetPage.getByLabel("Password", { exact: true }).fill(newPassword);
    await resetPage.getByRole("button", { name: "Reset password" }).click();

    // Signed in with the new password and taken into the app.
    await expect(resetPage).not.toHaveURL(/\/(invite|login)(\/|$)/, { timeout: 15000 });
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
