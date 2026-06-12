// @vitest-environment node
import { describe, it, expect } from "vitest";
import { deriveLicenseState } from "@/lib/license-state";
import { makeLicense } from "../helpers/license-fixtures";

const NOW = new Date("2026-06-12T12:00:00.000Z");
const DAYS = 86400000;

describe("deriveLicenseState", () => {
  it("returns community when there is no valid key", () => {
    const status = { active: false, features: [], ver: 1, maxUsers: 0 };
    expect(deriveLicenseState(status, NOW)).toBe("community");
  });

  it("returns trial for a valid trial key", () => {
    const status = makeLicense({ type: "trial" });
    expect(deriveLicenseState(status, NOW)).toBe("trial");
  });

  it("returns trial-expired for an expired trial key", () => {
    const status = makeLicense({
      active: false,
      expired: true,
      type: "trial",
      expiresAt: new Date(NOW.getTime() - 1 * DAYS),
    });
    expect(deriveLicenseState(status, NOW)).toBe("trial-expired");
  });

  it("returns paid for a valid paid key without paidUntil", () => {
    const status = makeLicense({ type: "paid" });
    expect(deriveLicenseState(status, NOW)).toBe("paid");
  });

  it("returns paid while now is before paidUntil", () => {
    const status = makeLicense({
      type: "paid",
      paidUntilAt: new Date(NOW.getTime() + 10 * DAYS),
    });
    expect(deriveLicenseState(status, NOW)).toBe("paid");
  });

  it("returns grace between paidUntil and exp", () => {
    const status = makeLicense({
      type: "paid",
      paidUntilAt: new Date(NOW.getTime() - 1 * DAYS),
      expiresAt: new Date(NOW.getTime() + 29 * DAYS),
    });
    expect(deriveLicenseState(status, NOW)).toBe("grace");
  });

  it("returns expired for a paid key past exp", () => {
    const status = makeLicense({
      active: false,
      expired: true,
      type: "paid",
      paidUntilAt: new Date(NOW.getTime() - 31 * DAYS),
      expiresAt: new Date(NOW.getTime() - 1 * DAYS),
    });
    expect(deriveLicenseState(status, NOW)).toBe("expired");
  });

  it("treats an active key without type as paid", () => {
    const status = makeLicense({ type: undefined });
    expect(deriveLicenseState(status, NOW)).toBe("paid");
  });

  it("treats an expired key without type as expired (not trial-expired)", () => {
    const status = makeLicense({ active: false, expired: true, type: undefined });
    expect(deriveLicenseState(status, NOW)).toBe("expired");
  });

  it("isLicenseActive reflects the gate-unlocking states", async () => {
    const { isLicenseActive } = await import("@/lib/license-state");
    expect(isLicenseActive("paid")).toBe(true);
    expect(isLicenseActive("trial")).toBe(true);
    expect(isLicenseActive("grace")).toBe(true);
    expect(isLicenseActive("community")).toBe(false);
    expect(isLicenseActive("trial-expired")).toBe(false);
    expect(isLicenseActive("expired")).toBe(false);
  });
});
