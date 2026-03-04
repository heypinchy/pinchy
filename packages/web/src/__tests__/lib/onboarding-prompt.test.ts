import { describe, it, expect } from "vitest";
import { getOnboardingPrompt, ONBOARDING_GREETING } from "@/lib/onboarding-prompt";

describe("getOnboardingPrompt", () => {
  it("returns user-only prompt for non-admin", () => {
    const prompt = getOnboardingPrompt(false);

    expect(prompt).toContain("save_user_context");
    expect(prompt).not.toContain("save_org_context");
    expect(prompt).not.toContain("organization");
  });

  it("returns user + org prompt for admin", () => {
    const prompt = getOnboardingPrompt(true);

    expect(prompt).toContain("save_user_context");
    expect(prompt).toContain("save_org_context");
    expect(prompt).toContain("organization");
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
