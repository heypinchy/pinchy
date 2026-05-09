import { describe, it, expect } from "vitest";
import { getOnboardingPrompt, ONBOARDING_GREETING } from "@/lib/onboarding-prompt";

describe("getOnboardingPrompt", () => {
  it("returns user-only prompt for non-admin", () => {
    const prompt = getOnboardingPrompt(false);

    expect(prompt).toContain("pinchy_save_user_context");
    expect(prompt).not.toContain("pinchy_save_org_context");
    expect(prompt).not.toContain("organization");
  });

  it("returns user + org prompt for admin", () => {
    const prompt = getOnboardingPrompt(true);

    expect(prompt).toContain("pinchy_save_user_context");
    expect(prompt).toContain("pinchy_save_org_context");
    expect(prompt).toContain("organization");
  });

  // The tools are registered in pinchy-context as `pinchy_save_user_context`
  // and `pinchy_save_org_context`. Referring to them in the prompt without the
  // `pinchy_` prefix breaks weaker tool-using models (e.g. Gemini 3 Flash
  // Preview) that follow the prompt literally and call a non-existent tool.
  it("uses the prefixed tool names so models call the registered tools", () => {
    const userPrompt = getOnboardingPrompt(false);
    const adminPrompt = getOnboardingPrompt(true);

    expect(userPrompt).not.toMatch(/(?<!pinchy_)save_user_context/);
    expect(adminPrompt).not.toMatch(/(?<!pinchy_)save_user_context/);
    expect(adminPrompt).not.toMatch(/(?<!pinchy_)save_org_context/);
  });

  it("does not ask for the user's name (name is already known from system context)", () => {
    const prompt = getOnboardingPrompt(false);
    // Name is injected via extraSystemPrompt — no need to gather it during onboarding
    expect(prompt).not.toContain("their name");
  });
});

describe("ONBOARDING_GREETING", () => {
  it("does not ask for the user's name (name is already known from system context)", () => {
    // Name is injected via extraSystemPrompt — greeting should not ask for it
    expect(ONBOARDING_GREETING).not.toContain("your name");
  });
});
