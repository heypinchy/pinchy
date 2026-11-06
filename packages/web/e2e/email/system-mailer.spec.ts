/**
 * System mailer (#1309) — an invitation leaves Pinchy as a real email and the
 * link in it works.
 *
 * Every layer below this is tested against a mocked transport. The claims only
 * a real SMTP server can check are the ones the feature rests on: that
 * nodemailer, with the options Pinchy builds, actually delivers; that the
 * message carries a link the recipient can open; and that the link creates
 * the account. GreenMail (already in this stack for pinchy-email) is that
 * server: auth disabled, plaintext on 3025, so the mailer is configured with
 * `security: "none"` and no username — the internal-relay shape.
 *
 * The SSRF guard lets `greenmail` through because this overlay sets
 * ALLOW_PRIVATE_MAIL_HOSTS=1 — the same production opt-in an operator sets for
 * an on-premise relay, not a test-only branch.
 */
import { test, expect } from "@playwright/test";

import { loginViaUI } from "../shared/dispatch-probe";
import {
  getAdminEmail,
  getAdminPassword,
  getGreenmailMailboxSource,
  login,
  pinchyDelete,
  pinchyGet,
  pinchyPost,
  pinchyPut,
  seedSetup,
  waitForImapMock,
  waitForPinchy,
} from "./helpers";

const RELAY = {
  host: "greenmail",
  port: 3025,
  security: "none",
  fromAddress: "pinchy@example.com",
  fromName: "Pinchy E2E",
};

/**
 * Waits until the mailbox holds more than `seenBefore` messages containing
 * `marker`, and returns the newest — the same condition the test asserts, so
 * a message left over in a re-used mailbox can't end the wait early.
 */
async function waitForNewMessage(
  address: string,
  marker: string,
  seenBefore: number,
  timeoutMs = 30_000
): Promise<string> {
  let matching: string[] = [];
  await expect
    .poll(
      async () => {
        matching = (await getGreenmailMailboxSource(address)).filter((m) => m.includes(marker));
        return matching.length;
      },
      { timeout: timeoutMs, message: `no new email containing "${marker}" for ${address}` }
    )
    .toBeGreaterThan(seenBefore);
  return matching[matching.length - 1];
}

async function countMessages(address: string, marker: string): Promise<number> {
  return (await getGreenmailMailboxSource(address)).filter((m) => m.includes(marker)).length;
}

/** The invite link, unwrapped from quoted-printable soft line breaks. */
function extractInviteLink(source: string): string {
  const unfolded = source.replace(/=\r?\n/g, "");
  const match = unfolded.match(/https?:\/\/[^\s"<>]+\/invite\/[0-9a-f]{64}/);
  if (!match) throw new Error(`no invite link in the email:\n${unfolded.slice(0, 2000)}`);
  return match[0];
}

test.describe("System mailer — invitations arrive by email", () => {
  let cookie: string;

  test.beforeAll(async () => {
    await waitForPinchy();
    await waitForImapMock();
    await seedSetup();
    cookie = await login();
  });

  test.afterAll(async () => {
    // Leave the stack as other specs expect it: no mailer.
    if (cookie) await pinchyDelete("/api/settings/mail", cookie);
  });

  test("an admin connects a relay; saving verifies it and the test email arrives", async () => {
    const save = await pinchyPut("/api/settings/mail", RELAY, cookie);
    expect(save.status, await save.clone().text()).toBe(200);
    const status = await save.json();
    expect(status).toMatchObject({ configured: true, config: { host: "greenmail" } });

    // The admin's mailbox survives between local runs: count first.
    const marker = "Pinchy can send email";
    const seenBefore = await countMessages(getAdminEmail(), marker);

    const testSend = await pinchyPost("/api/settings/mail/test", {}, cookie);
    expect(testSend.status, await testSend.clone().text()).toBe(200);

    await waitForNewMessage(getAdminEmail(), marker, seenBefore);

    // mail.sent is written after the response (deferAuditLog), so poll for it.
    let rows: Array<{ outcome: string; detail: { purpose?: string } }> = [];
    await expect
      .poll(async () => {
        const audit = await pinchyGet("/api/audit?eventType=mail.sent&limit=10", cookie);
        rows = (await audit.json()).entries;
        return rows.some((r) => r.outcome === "success" && r.detail?.purpose === "test");
      })
      .toBe(true);
    // The recipient is never in the audit trail in plain text.
    expect(JSON.stringify(rows)).not.toContain(getAdminEmail());
  });

  test("Send invitation emails a link that creates the account", async ({ page }) => {
    const save = await pinchyPut("/api/settings/mail", RELAY, cookie);
    expect(save.status).toBe(200);

    const invitee = `invitee-${Date.now()}@example.com`;

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto("/settings?tab=users");
    await page.getByRole("button", { name: "Invite User" }).click();
    await page.getByLabel("Email").fill(invitee);
    await page.getByRole("button", { name: "Send invitation" }).click();

    await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
    // The link stays on screen: copying it is always possible.
    await expect(page.getByText(/\/invite\/[0-9a-f]{64}/)).toBeVisible();

    // A fresh address per run, so nothing was there before.
    const source = await waitForNewMessage(invitee, "invited you to Pinchy", 0);
    const link = extractInviteLink(source);

    // A fresh browser context: the invitee is not the signed-in admin.
    const invitePage = await page.context().browser()!.newPage();
    try {
      await invitePage.goto(link);
      await invitePage.getByLabel("Name").fill("Invited Person");
      await invitePage.getByLabel("Password", { exact: true }).fill("invitee-password-123");
      await invitePage.getByLabel("Confirm password").fill("invitee-password-123");
      await invitePage.getByRole("button", { name: "Create account" }).click();
      // Claiming also creates the invitee's personal agent and regenerates the
      // OpenClaw config; with a real OpenClaw in this stack that can take well
      // over the default 5s (CI run 42112256594 sat on "Creating account...").
      await expect(invitePage.getByText("Account created!")).toBeVisible({ timeout: 30_000 });
    } finally {
      await invitePage.close();
    }

    // The account exists: the invitee can sign in.
    const inviteeCookie = await login(invitee, "invitee-password-123");
    expect(inviteeCookie).toBeTruthy();
  });
});
