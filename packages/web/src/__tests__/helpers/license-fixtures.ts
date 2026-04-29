import type { LicenseStatus } from "@/lib/license";

export function makeLicense(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    active: true,
    type: "paid",
    org: "Test Org",
    features: ["enterprise"],
    expiresAt: new Date("2027-04-27T00:00:00.000Z"),
    daysRemaining: 365,
    ver: 1,
    maxUsers: 0,
    ...overrides,
  };
}
