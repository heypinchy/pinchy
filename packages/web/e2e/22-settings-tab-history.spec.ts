import { test, expect, type Page } from "@playwright/test";
import { loginAsAdmin, seedProviderConfig } from "./helpers";

/**
 * Click a tab and wait for the URL to follow, retrying the click itself.
 *
 * A click that lands before hydration is silently dropped — the tab never
 * switches and the URL never moves (the same race documented at length in
 * `06-user-management.spec.ts`). Retrying the click rather than sleeping
 * before it keeps the test honest about what it waits for. Re-clicking an
 * already-active tab is a no-op in Radix (`onValueChange` fires on change
 * only), so a retry cannot inflate the history this test measures.
 */
async function selectTab(page: Page, name: string, expectedUrl: RegExp) {
  await expect(async () => {
    await page.getByRole("tab", { name }).click();
    await expect(page).toHaveURL(expectedUrl, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/**
 * Browser Back must walk back through the settings tabs the user visited (#951).
 *
 * The unit tests in `use-tab-param.test.ts` pin which router method the hook
 * calls. That is the mechanism, not the outcome — and the mechanism is exactly
 * what looked fine while the bug was live: `router.replace` is a perfectly
 * ordinary call, it just leaves no history entry behind. What a user actually
 * gets from a sequence of tab clicks is a question only a real browser history
 * stack can answer, so this asks it there.
 */
test.describe("Settings tab history", () => {
  test("Back walks back through the visited tabs", async ({ page }) => {
    // Without a configured provider the first login lands on /setup/provider
    // instead of the app shell, and `loginAsAdmin` waits for /chat/.
    await seedProviderConfig();
    await loginAsAdmin(page);

    const chatUrl = page.url();

    await page.goto("/settings");
    await selectTab(page, "Profile", /\?tab=profile$/);
    await selectTab(page, "Telegram", /\?tab=telegram$/);
    await selectTab(page, "Support", /\?tab=support$/);

    // The reported repro: three Back presses used to leave Settings entirely,
    // because all four visits collapsed into a single history entry.
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=telegram$/);
    await expect(page.getByRole("tab", { name: "Telegram" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await page.goBack();
    await expect(page).toHaveURL(/\?tab=profile$/);
    await expect(page.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Back to the tab-less entry, which renders the default tab. Landing here
    // was the reported symptom — it just arrived one press too early, because
    // the tabs in between never got entries of their own.
    await page.goBack();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("tab", { name: "Context" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // …and only once the tabs are exhausted does Back leave Settings.
    await page.goBack();
    await expect(page).toHaveURL(chatUrl);
  });
});
