import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with Anthropic", () => {
  test.beforeAll(() => resetStack());

  test("fresh install: wizard → Anthropic → first Smithers message succeeds", async ({ page }) => {
    await runProviderSmokeTest(page, {
      provider: "anthropic",
      // Provider button label comes from PROVIDERS[].name in
      // packages/web/src/components/provider-key-form.tsx ("Anthropic").
      buttonName: /anthropic/i,
      // Placeholder from packages/web/src/lib/providers.ts ("sk-ant-...").
      // Anthropic-specific prefix distinguishes it from the OpenAI "sk-..."
      // placeholder so the locator can't accidentally match the wrong field.
      placeholderRegex: /sk-ant-/i,
      keyValue: "sk-ant-mock-test-key",
    });
  });
});
