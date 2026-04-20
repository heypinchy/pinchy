import { describe, it, expect } from "vitest";
import { PROVIDERS } from "@/lib/providers";

describe("PROVIDERS.authMethods", () => {
  it("openai exposes both api-key and subscription", () => {
    expect(PROVIDERS.openai.authMethods).toEqual(["api-key", "subscription"]);
  });

  it("other providers expose only api-key (or url)", () => {
    expect(PROVIDERS.anthropic.authMethods).toEqual(["api-key"]);
    expect(PROVIDERS.google.authMethods).toEqual(["api-key"]);
    expect(PROVIDERS["ollama-cloud"].authMethods).toEqual(["api-key"]);
    expect(PROVIDERS["ollama-local"].authMethods).toEqual(["url"]);
  });
});
