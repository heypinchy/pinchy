import { describe, expect, it } from "vitest";
import { getBetterAuthUrlStartupWarning } from "@/lib/auth-env-warning";

describe("getBetterAuthUrlStartupWarning", () => {
  it("does not warn when BETTER_AUTH_URL is unset and Domain Lock is not configured", () => {
    expect(getBetterAuthUrlStartupWarning({}, null)).toBeNull();
    expect(getBetterAuthUrlStartupWarning({ BETTER_AUTH_URL: "" }, null)).toBeNull();
  });

  it("explains what BETTER_AUTH_URL controls when set", () => {
    const warning = getBetterAuthUrlStartupWarning(
      {
        BETTER_AUTH_URL: "https://pinchy.example.com",
      },
      null
    );

    expect(warning).toContain("Domain Lock");
    // Must name the concrete things BETTER_AUTH_URL still controls, not the
    // generic "callback URLs" phrase — admins shouldn't have to guess whether
    // that affects them.
    expect(warning).toMatch(/email verification|password reset/i);
  });

  it("does not say BETTER_AUTH_URL is unused", () => {
    const warning = getBetterAuthUrlStartupWarning(
      {
        BETTER_AUTH_URL: "https://pinchy.example.com",
      },
      null
    );

    expect(warning).not.toContain("no longer used");
  });

  it("warns when Domain Lock is set but BETTER_AUTH_URL is unset", () => {
    const warning = getBetterAuthUrlStartupWarning({}, "pinchy.example.com");

    expect(warning).not.toBeNull();
    // Operator needs to know exactly which env var and which feature is at risk.
    expect(warning).toContain("BETTER_AUTH_URL");
    expect(warning).toContain("Domain Lock");
    expect(warning).toMatch(/email verification|password reset/i);
  });

  it("includes the locked domain in the suggested BETTER_AUTH_URL value", () => {
    const warning = getBetterAuthUrlStartupWarning({}, "pinchy.example.com");

    // Without the concrete URL, ops staff have to look up the locked domain
    // from Settings → Security; with it, the fix is copy-paste.
    expect(warning).toContain("https://pinchy.example.com");
  });

  it("treats an empty BETTER_AUTH_URL as unset for the Domain-Lock check", () => {
    const warning = getBetterAuthUrlStartupWarning({ BETTER_AUTH_URL: "" }, "pinchy.example.com");

    // Same misconfiguration as fully-unset — the warning must fire.
    expect(warning).not.toBeNull();
    expect(warning).toContain("BETTER_AUTH_URL");
  });

  it("does not double-warn when both BETTER_AUTH_URL and Domain Lock are set", () => {
    const warning = getBetterAuthUrlStartupWarning(
      { BETTER_AUTH_URL: "https://pinchy.example.com" },
      "pinchy.example.com"
    );

    // The URL-set warning wins — the missing-URL message must not appear too.
    expect(warning).not.toBeNull();
    expect(warning).not.toMatch(/is unset|not set/i);
  });
});
