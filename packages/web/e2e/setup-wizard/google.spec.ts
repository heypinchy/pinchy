import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with Google", () => {
  test.beforeAll(() => resetStack());

  test("fresh install: wizard → Google → first Smithers message succeeds", async ({ page }) => {
    await runProviderSmokeTest(page, {
      provider: "google",
      // Provider button label comes from PROVIDERS[].name in
      // packages/web/src/components/provider-key-form.tsx ("Google").
      buttonName: /^google$/i,
      // Placeholder from packages/web/src/lib/providers.ts ("AIza..."), which
      // is the prefix Google API keys use.
      placeholderRegex: /AIza/i,
      keyValue: "AIza-mock-test-key",
    });
  });
});
