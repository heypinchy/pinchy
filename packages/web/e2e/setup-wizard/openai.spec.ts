import { test, expect } from "@playwright/test";
import { resetStack } from "./helpers";

test.describe("Setup wizard → first chat with OpenAI", () => {
  test.beforeAll(() => resetStack());

  test("fresh install: wizard → provider → first Smithers message succeeds", async ({ page }) => {
    // Phase 1: admin account
    await page.goto("/setup", { waitUntil: "networkidle" });
    await page.getByLabel(/name/i).fill("Smoke Test Admin");
    await page.getByLabel(/email/i).fill("smoke@test.local");
    await page.getByLabel("Password", { exact: true }).fill("smoke-test-password-123");
    await page.getByLabel(/confirm password/i).fill("smoke-test-password-123");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.getByText(/account created successfully/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /continue to sign in/i }).click();

    // Phase 2: sign in
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel(/email/i).fill("smoke@test.local");
    await page.getByLabel("Password", { exact: true }).fill("smoke-test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    // Phase 3: OpenAI provider with mock key (mock accepts any non-empty Bearer).
    // The submit button label in ProviderKeyForm is "Continue" (the default
    // submitLabel) on the setup-wizard path — not "Connect" or "Save", those
    // only appear in /settings/providers where `configuredProviders` is passed.
    await page.getByRole("button", { name: /openai/i }).click();
    await page.getByPlaceholder(/sk-/i).fill("sk-mock-test-key");
    await page.getByRole("button", { name: /^continue$/i }).click();
    await expect(page.getByText(/provider connected/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /continue to pinchy/i }).click();

    // Phase 4: first message — the bug surface.
    // v0.5.6 race: openclaw.json is regenerated but secrets.json may not be
    // flushed before the first chat hits Gateway → OpenClaw replies with
    // "No API key found for provider 'openai'" and Pinchy renders an error.
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
    await expect(page.getByText(/i'm smithers/i)).toBeVisible({ timeout: 30000 });

    const composer = page.getByPlaceholder(/send a message/i);
    await composer.fill("Hello, are you working?");
    await composer.press("Enter");

    // Assert: Smithers' response renders. The bug surfaces as the
    // "Smithers couldn't respond — No API key found for provider 'openai'"
    // toast/inline error. We assert the mock's deterministic content
    // ("Sure, happy to help! What would you like to work on?") and that
    // NO error UI is shown.
    await expect(page.getByText(/sure, happy to help/i)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/smithers couldn't respond/i)).not.toBeVisible();
    await expect(page.getByText(/no api key found/i)).not.toBeVisible();
  });
});
