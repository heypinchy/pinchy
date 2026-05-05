import { describe, expect, it } from "vitest";
import { getBetterAuthUrlStartupWarning } from "@/lib/auth-env-warning";

describe("getBetterAuthUrlStartupWarning", () => {
  it("does not warn when BETTER_AUTH_URL is unset or empty", () => {
    expect(getBetterAuthUrlStartupWarning({})).toBeNull();
    expect(getBetterAuthUrlStartupWarning({ BETTER_AUTH_URL: "" })).toBeNull();
  });

  it("explains that BETTER_AUTH_URL still controls callback URLs", () => {
    const warning = getBetterAuthUrlStartupWarning({
      BETTER_AUTH_URL: "https://pinchy.example.com",
    });

    expect(warning).toContain("Domain Lock is configured via Settings");
    expect(warning).toContain("still controls Better Auth callback URLs");
  });

  it("does not say BETTER_AUTH_URL is unused", () => {
    const warning = getBetterAuthUrlStartupWarning({
      BETTER_AUTH_URL: "https://pinchy.example.com",
    });

    expect(warning).not.toContain("no longer used");
  });
});
