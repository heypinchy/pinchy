import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with OpenAI", () => {
  test.beforeAll(resetStack);

  test("fresh install: wizard → OpenAI → first Smithers message succeeds", async ({ page }) => {
    await runProviderSmokeTest(page, {
      provider: "openai",
      buttonName: /openai/i,
      placeholderRegex: /sk-/i,
      keyValue: "sk-mock-test-key",
    });
  });
});
