import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with OpenAI", () => {
  test.beforeAll(resetStack);

  test("fresh install: wizard → OpenAI → first Smithers message succeeds", async ({ page }) => {
    await runProviderSmokeTest(page, {
      // Anchored so it matches the "OpenAI" tile exactly and NOT the sixth
      // "OpenAI-compatible" button added in #894 (a loose /openai/i matches both
      // → Playwright strict-mode violation).
      provider: "openai",
      buttonName: /^openai$/i,
      placeholderRegex: /sk-/i,
      keyValue: "sk-mock-test-key",
    });
  });
});
