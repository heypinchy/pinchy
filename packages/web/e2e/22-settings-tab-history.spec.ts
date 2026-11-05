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

/**
 * Switching tabs must not reload Settings (#1271).
 *
 * The tab lives in `?tab=`, and the App Router keys the page segment by its
 * search params — so a `router.push` to a new tab value threw the whole page
 * away, re-ran the server component, and remounted every tab. Each switch
 * showed "Loading..." for as long as that round trip and the refetches took.
 *
 * The probe is element identity: a node rendered by the page before the
 * switch must still be the same node after it. A remount replaces it, and
 * that replacement has already happened by the time the URL has moved.
 */
test.describe("Settings tab switching", () => {
  test("keeps the page mounted and its loaded data across tab switches", async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);

    const usersFetches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "GET" && new URL(req.url()).pathname === "/api/users") {
        usersFetches.push(req.url());
      }
    });

    await page.goto("/settings?tab=users");
    await expect(page.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => usersFetches.length).toBeGreaterThan(0);
    await expect(page.getByText("Loading...").filter({ visible: true })).toHaveCount(0);
    const fetchesBefore = usersFetches.length;

    // The page's own heading, not anything in the app shell around it — the
    // shell survives a remount, so it would prove nothing.
    const settingsHeading = () =>
      Array.from(document.querySelectorAll("h1")).find((h) => h.textContent === "Settings") ?? null;
    await page.evaluate(`window.__settingsHeading = (${settingsHeading.toString()})()`);
    expect(await page.evaluate("window.__settingsHeading !== null")).toBe(true);

    await selectTab(page, "Groups", /\?tab=groups$/);
    await selectTab(page, "Users", /\?tab=users$/);

    const sameHeading = await page.evaluate(
      `(${settingsHeading.toString()})() === window.__settingsHeading`
    );
    expect(sameHeading, "the settings page was remounted by a tab switch").toBe(true);
    await expect(page.getByText("Loading...").filter({ visible: true })).toHaveCount(0);
    expect(usersFetches.length).toBe(fetchesBefore);
  });
});
