import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

// Agent Provisioning API keys — Settings → API Keys (#572).
//
// Every comparable admin surface has a spec here (06-user-management,
// 09-groups, 10-agent-permissions, 11-user-invite, 12-audit-log); this one was
// missing. It covers the two things the component tests structurally cannot:
//
//   1. The one-time plaintext. `settings-api-keys.test.tsx` asserts the modal
//      renders the secret and that closing it clears React state. What it can't
//      show is that the key never comes back — because in a component test the
//      list is a mock. Here the list is a real GET against a real row, so
//      "shown once" is checked against the thing that actually stores it.
//
//   2. The masked identifier. It shipped broken: `defaultPrefix` is 7 chars and
//      the plugin's `start` default was 6, so every row read `pinchy…` and the
//      column that exists to tell keys apart told them apart from nothing.
//      Fixtures couldn't catch it — they were hand-written values the plugin
//      cannot produce. Two keys created through the real stack can.
//
// Unique names per run so retries don't collide with prior rows.
const RUN = Date.now();
const KEY_A = `E2E CI Deploy ${RUN}`;
const KEY_B = `E2E Read Only ${RUN}`;

async function openApiKeysTab(page: import("@playwright/test").Page) {
  await page.goto("/settings?tab=apikeys");
  await expect(page.getByRole("button", { name: "New API Key" })).toBeVisible({ timeout: 15000 });
}

/**
 * Creates a key through the UI and returns the one-time plaintext it displayed.
 *
 * Every locator is scoped to the dialog: the settings page also renders the
 * Profile tab, whose "Your name" field answers to getByLabel("Name") too.
 */
async function createKey(
  page: import("@playwright/test").Page,
  name: string,
  scope: string
): Promise<string> {
  await page.getByRole("button", { name: "New API Key" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("checkbox", { name: scope }).click();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // The secret is rendered exactly once, right here.
  const secret = page.getByRole("dialog").getByText(/^pinchy_/);
  await expect(secret).toBeVisible({ timeout: 15000 });
  const plaintext = (await secret.textContent())?.trim() ?? "";
  expect(plaintext.startsWith("pinchy_")).toBe(true);
  return plaintext;
}

test.describe.serial("Agent Provisioning API keys", () => {
  test.beforeAll(async () => {
    await seedProviderConfig();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("shows the plaintext key exactly once, and never again", async ({ page }) => {
    await openApiKeysTab(page);
    const plaintext = await createKey(page, KEY_A, "Read agents");

    // Close the one-time modal. From here the secret is gone for good — Pinchy
    // never stored it, so there is nowhere for it to come back from.
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText(KEY_A)).toBeVisible();

    // THE assertion, and the reason this is an E2E test: the list is a real GET
    // against the real row. If the route ever spread the raw record instead of
    // masking it, or the modal's state leaked into the table, the full secret
    // would be sitting on this page.
    await expect(page.getByText(plaintext, { exact: true })).toHaveCount(0);

    // A reload is the honest test of "never again": fresh page, fresh fetch,
    // nothing held in memory from the create.
    await page.reload();
    await expect(page.getByText(KEY_A)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(plaintext, { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(plaintext);
  });

  test("masks each key to a start that actually distinguishes it", async ({ page }) => {
    await openApiKeysTab(page);
    const secondPlaintext = await createKey(page, KEY_B, "Read agents");
    await page.getByRole("button", { name: "Done" }).click();

    const rowA = page.getByRole("row").filter({ hasText: KEY_A });
    const rowB = page.getByRole("row").filter({ hasText: KEY_B });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    const maskA = (await rowA.getByText(/^pinchy_/).textContent())?.trim() ?? "";
    const maskB = (await rowB.getByText(/^pinchy_/).textContent())?.trim() ?? "";

    // The regression this exists for: both of these read "pinchy…" before the
    // fix, so an admin holding a leaked credential had no way to tell which row
    // to revoke.
    expect(maskA).not.toBe(maskB);
    // It has to be a real prefix of the key it stands for — that's what makes
    // it matchable against what's in a CI secret store.
    expect(secondPlaintext.startsWith(maskB.replace(/…$/, ""))).toBe(true);
    // ...and still a mask, not the secret.
    expect(maskB.replace(/…$/, "").length).toBeLessThan(secondPlaintext.length);
  });

  test("revokes a key without touching its neighbour", async ({ page }) => {
    await openApiKeysTab(page);

    const rowB = page.getByRole("row").filter({ hasText: KEY_B });
    await rowB.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).last().click();

    // The bystander is the point: the revoke route hand-writes its DELETE, and
    // an unpinned WHERE would take every key with it while still answering 200.
    await expect(page.getByText(KEY_B)).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText(KEY_A)).toBeVisible();

    // Survives a reload, i.e. the row is really gone rather than filtered out
    // of a stale client list.
    await page.reload();
    await expect(page.getByText(KEY_A)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(KEY_B)).toHaveCount(0);
  });
});
