import { test, expect } from "@playwright/test";
import { seedProviderConfig, loginAsAdmin } from "./helpers";

/**
 * Regression guard for the v0.5.4 composer cursor-jump bug.
 *
 * A defensive onChange wrapper around `ComposerPrimitive.Input` (added in
 * commit 7044e12ea to fix a dead-key sync issue) called
 * `composerRuntime.setText(e.target.value)` on every non-composing
 * keystroke. assistant-ui's primitive already does that internally —
 * Pinchy's wrapper double-fired the same state update, and the combined
 * re-render path collapsed the textarea's selection to the end after
 * every keystroke.
 *
 * User-visible symptom: editing in the middle of an existing draft loses
 * the caret after every typed character. Inserting "XYZ" between "hello"
 * and " world" produces "helloX worldYZ" instead of "helloXYZ world",
 * because only the first character lands at the intended position before
 * the caret jumps back to the end.
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

  test("inserting text mid-string keeps the caret in the middle", async ({ page }) => {
    // Open Smithers — every fresh test DB seeds one as the admin's
    // personal agent and the chat list shows it as the first link.
    const smithersLink = page.getByRole("link", { name: /smithers/i }).first();
    await smithersLink.waitFor({ timeout: 10000 });
    const href = await smithersLink.getAttribute("href");
    expect(href).toMatch(/\/chat\/[0-9a-f-]+/);
    await smithersLink.click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.click();

    // Type the initial text key-by-key so React's onChange fires per
    // character — matches what a real user does and what triggered the
    // bug in production. `input.fill()` would use Playwright's
    // fast-set-value path and bypass the very flow we want to exercise.
    await page.keyboard.type("hello world");
    await expect(input).toHaveValue("hello world");

    // Move the caret from the end of the typed text back to position 5,
    // between "hello" and " world". Pure keyboard navigation, no
    // explicit focus/evaluate calls — earlier revisions of this test
    // tried `input.focus() + setSelectionRange(5, 5)` via input.evaluate
    // and the textarea's value disappeared between that step and the
    // next assertion (Received: "XYZ"), almost certainly because the
    // evaluate-handle's element reference went stale across React's
    // controlled re-render. Sticking to keyboard events keeps the test
    // in the textarea's natural focus path.
    for (let i = 0; i < " world".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }

    // Insert "XYZ" at the caret. With the cursor-jump bug present, the
    // first character lands at position 5 but the caret then snaps to
    // the end and the next two land there too — producing
    // "helloX worldYZ" instead of the correct "helloXYZ world".
    await page.keyboard.type("XYZ");

    await expect(input).toHaveValue("helloXYZ world");
  });
});
