import { describe, expect, it } from "vitest";
import { getBetterAuthUrlStartupWarning } from "@/lib/auth-env-warning";

describe("getBetterAuthUrlStartupWarning", () => {
  it("does not warn when BETTER_AUTH_URL is unset or empty", () => {
    expect(getBetterAuthUrlStartupWarning({})).toBeNull();
    expect(getBetterAuthUrlStartupWarning({ BETTER_AUTH_URL: "" })).toBeNull();
  });

  it("explains what BETTER_AUTH_URL controls when set", () => {
    const warning = getBetterAuthUrlStartupWarning({
      BETTER_AUTH_URL: "https://pinchy.example.com",
    });

    expect(warning).toContain("Domain Lock");
    // Must name the concrete things BETTER_AUTH_URL still controls, not the
    // generic "callback URLs" phrase — admins shouldn't have to guess whether
    // that affects them.
    expect(warning).toMatch(/email verification|password reset/i);
  });

  it("does not say BETTER_AUTH_URL is unused", () => {
    const warning = getBetterAuthUrlStartupWarning({
      BETTER_AUTH_URL: "https://pinchy.example.com",
    });

    expect(warning).not.toContain("no longer used");
  });
});
