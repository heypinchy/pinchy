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

  it("contains the platform knowledge section pointing to docs tools", () => {
    expect(SMITHERS_SOUL_MD).toContain("## Platform Knowledge");
    // Knowledge is now sourced on demand from docs via plugin tools.
    expect(SMITHERS_SOUL_MD).toContain("docs_list");
    expect(SMITHERS_SOUL_MD).toContain("docs_read");
  });

  it("instructs Smithers to admit when no doc covers the question instead of guessing", () => {
    // Smaller local models drift into invention when docs_list returns no
    // matching file. The SOUL must give them a concrete fall-through script
    // ("don't guess, say you don't know") because generic instructions like
    // "don't fabricate" are not strong enough on 7-9B models.
    const lower = SMITHERS_SOUL_MD.toLowerCase();
    expect(lower).toContain("never");
    expect(lower).toMatch(/(do not guess|don't guess|never guess)/);
    // The fall-through must point users somewhere actionable rather than
    // leaving them with a dead-end "I don't know."
    expect(lower).toMatch(/(github|issue|discussion|report)/);
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

  it("does not duplicate platform knowledge that lives in the docs", () => {
    // Docs are the single source of truth — Smithers reads them on demand via
    // docs_list/docs_read. Inlining feature summaries here makes the SOUL drift
    // from the docs and contradicts the "never guess, always read docs" rule.
    expect(SMITHERS_SOUL_MD).not.toContain("### Audit Trail");
    expect(SMITHERS_SOUL_MD).not.toContain("### Settings & Restarts");
    expect(SMITHERS_SOUL_MD).not.toContain("### Domain & HTTPS");
    expect(SMITHERS_SOUL_MD).not.toContain("### Context");
    expect(SMITHERS_SOUL_MD).not.toContain("### Usage & Costs");
    expect(SMITHERS_SOUL_MD).not.toContain("### Enterprise Features");
    expect(SMITHERS_SOUL_MD).not.toContain("### Common Tasks");
  });
});
