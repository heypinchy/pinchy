import { describe, it, expect } from "vitest";
import { deriveProviderSlug, RESERVED_PROVIDER_SLUGS } from "@/lib/openai-compatible-slug";
import { PROVIDERS } from "@/lib/providers";

describe("deriveProviderSlug", () => {
  it("kebab-cases a display name", () => {
    expect(deriveProviderSlug("Swisscom AI Platform", new Set())).toBe("swisscom-ai-platform");
  });
  it("strips diacritics and punctuation", () => {
    expect(deriveProviderSlug("Télékom GmbH!", new Set())).toBe("telekom-gmbh");
  });
  it("suffixes on collision", () => {
    expect(deriveProviderSlug("Swisscom", new Set(["swisscom"]))).toBe("swisscom-2");
    expect(deriveProviderSlug("Swisscom", new Set(["swisscom", "swisscom-2"]))).toBe("swisscom-3");
  });
  it("suffixes when it would collide with a built-in name", () => {
    expect(deriveProviderSlug("OpenAI", new Set())).toBe("openai-2");
    expect(RESERVED_PROVIDER_SLUGS.has("openai")).toBe(true);
  });
  it("falls back for an all-punctuation name", () => {
    expect(deriveProviderSlug("!!!", new Set())).toBe("provider");
  });
  it("reserves every built-in provider name", () => {
    for (const name of Object.keys(PROVIDERS)) {
      expect(RESERVED_PROVIDER_SLUGS.has(name)).toBe(true);
    }
  });
});
