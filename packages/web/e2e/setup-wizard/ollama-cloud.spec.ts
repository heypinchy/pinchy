import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with Ollama Cloud", () => {
  test.beforeAll(() => resetStack());

  test("fresh install: wizard → Ollama Cloud → first Smithers message succeeds", async ({
    page,
  }) => {
    await runProviderSmokeTest(page, {
      provider: "ollama-cloud",
      // Provider button label comes from PROVIDERS[].name in
      // packages/web/src/components/provider-key-form.tsx ("Ollama Cloud").
      // We anchor on "ollama cloud" specifically so the locator can't match
      // the sibling "Ollama (Local)" button rendered in the same grid.
      buttonName: /ollama cloud/i,
      // Placeholder from packages/web/src/lib/providers.ts ("sk-..."). Same
      // prefix as OpenAI — fine here because only one API-key input exists
      // on the form at a time (the selected provider's).
      placeholderRegex: /sk-/i,
      keyValue: "sk-ollama-mock-test-key",
    });
  });
});
