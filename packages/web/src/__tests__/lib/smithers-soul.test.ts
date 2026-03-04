import { describe, it, expect } from "vitest";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";

describe("SMITHERS_SOUL_MD", () => {
  it("is a non-empty string", () => {
    expect(typeof SMITHERS_SOUL_MD).toBe("string");
    expect(SMITHERS_SOUL_MD.length).toBeGreaterThan(0);
  });

  it("contains the personality section", () => {
    expect(SMITHERS_SOUL_MD).toContain("## Personality");
  });

  it("contains the platform knowledge section", () => {
    expect(SMITHERS_SOUL_MD).toContain("## Platform Knowledge");
  });

  it("does not contain gendered honorifics", () => {
    expect(SMITHERS_SOUL_MD).not.toMatch(/\bSir\b/);
    expect(SMITHERS_SOUL_MD).not.toMatch(/\bMa'am\b/);
    expect(SMITHERS_SOUL_MD).not.toMatch(/\bMadam\b/);
  });

  it("instructs to respond in the user's language", () => {
    expect(SMITHERS_SOUL_MD).toContain("same language the user writes in");
  });

  it("instructs not to treat encounters as first meetings", () => {
    expect(SMITHERS_SOUL_MD).toContain("never say");
    expect(SMITHERS_SOUL_MD.toLowerCase()).toContain("nice to meet you");
  });

  it("does not list name as something to gather during onboarding (name is in system context)", () => {
    // Name is injected via extraSystemPrompt — no need to gather it during onboarding
    expect(SMITHERS_SOUL_MD).not.toContain("four key details");
  });

  it("notes that user name is available in system context rather than needing to be learned", () => {
    expect(SMITHERS_SOUL_MD).not.toContain("When you learn the user's name");
    expect(SMITHERS_SOUL_MD).toContain("available in your context");
  });
});
