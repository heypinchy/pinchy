// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  PRICING_URL,
  PRICING_TRIAL_URL,
  BUY_PRO_URL,
  PORTAL_URL,
  SALES_MAILTO,
  CALENDLY_URL,
  conversionLink,
} from "@/lib/conversion-links";

describe("conversion link constants", () => {
  it("point at the public funnel surfaces", () => {
    expect(PRICING_URL).toBe("https://heypinchy.com/pricing");
    expect(PRICING_TRIAL_URL).toBe("https://heypinchy.com/pricing#trial");
    expect(BUY_PRO_URL).toBe("https://buy.heypinchy.com/shop/pinchy-pro-5");
    expect(PORTAL_URL).toBe("https://buy.heypinchy.com/my");
    expect(CALENDLY_URL).toBe("https://calendly.com/clemenshelm/pinchy-demo");
  });

  it("sales mailto has a static prefilled subject and no body", () => {
    expect(SALES_MAILTO).toBe(
      "mailto:sales@heypinchy.com?subject=Pinchy%20seats%20quote%20request"
    );
  });
});

describe("conversionLink", () => {
  it("appends the static UTM triple", () => {
    expect(conversionLink(PRICING_URL, "settings-license", "pro-10")).toBe(
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=settings-license&utm_campaign=pro-10"
    );
  });

  it("keeps a #fragment after the UTM params", () => {
    expect(conversionLink(PRICING_TRIAL_URL, "cliff-modal", "groups")).toBe(
      "https://heypinchy.com/pricing?utm_source=pinchy-app&utm_medium=cliff-modal&utm_campaign=groups#trial"
    );
  });

  it("builds buy links for the trial banner", () => {
    expect(conversionLink(BUY_PRO_URL, "trial-banner", "pro-10")).toBe(
      "https://buy.heypinchy.com/shop/pinchy-pro-5?utm_source=pinchy-app&utm_medium=trial-banner&utm_campaign=pro-10"
    );
  });

  // D-011 zero-telemetry: links must be fully static. No instance or user
  // identifiers may ever reach a URL — the only variable parts are the
  // vocabulary-typed medium and campaign.
  it("produces no characters outside the static URL alphabet (D-011)", () => {
    const url = conversionLink(BUY_PRO_URL, "expired-banner", "pro-10");
    expect(url).not.toMatch(/%[0-9A-F]{2}/i);
    expect(new URL(url).searchParams.size).toBe(3);
  });
});
