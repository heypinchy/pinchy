import { describe, it, expect } from "vitest";
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";

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
});
