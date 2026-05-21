import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

/**
 * Regression guard for the v0.5.4 composer cursor-jump bug.
 *
 * User-reported symptom on staging running 222e6d79f: inserting characters
 * at a mid-text caret position produced output as if the caret jumped to
 * the end of the textarea after every character. Reproduced with both
 * mouse-click and keyboard ArrowLeft cursor positioning.
 *
 * Minimal reproduction: start with "abc", move caret to position 0, type
 * "X". Expected: "Xabc". Bug: "abcX" (caret jumped to end).
 *
 * jsdom unit tests can't catch this — DOM selection and the
 * textarea.value imperative-rewrite path that triggers the jump are
 * browser-specific. Playwright drives a real Chromium so this test
 * exercises the same flow a user does.
 */
test.describe("Composer cursor preservation", () => {
  test.beforeEach(async ({ page }) => {
    await seedProviderConfig();
    await loginAsAdmin(page);
  });

  test("typing at start of existing text stays at start", async ({ page }) => {
    const smithersLink = page.getByRole("link", { name: /smithers/i }).first();
    await smithersLink.waitFor({ timeout: 10000 });
    await smithersLink.click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.click();

    // Seed initial content via fill — fast, single React state update.
    // The cursor-jump bug doesn't manifest on initial typing into an empty
    // textarea (the caret is already at the end), so we don't need to
    // exercise the per-keystroke path here. The bug surfaces on the next
    // step where we type at a mid-text caret.
    await input.fill("abc");
    await expect(input).toHaveValue("abc");

    // Move caret to position 0 via Home key. With the cursor-jump bug,
    // assistant-ui's imperative textarea.value rewrite after each char
    // collapses the selection to the end of the text, so any subsequent
    // typed character lands at the end no matter where Home put the
    // caret.
    await input.press("Home");

    // Type one character at the caret. If the caret was preserved at
    // position 0, the result is "Xabc". If the caret jumped to the end
    // before the character was inserted, the result is "abcX".
    await input.press("X");

    await expect(input).toHaveValue("Xabc");
  });
});
