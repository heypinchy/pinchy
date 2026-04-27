// packages/web/src/__tests__/helpers/license-fixtures.ts
import type { LicenseStatus } from "@/lib/license";

export function makeLicense(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    active: true,
    type: "paid",
    org: "Test Org",
    features: ["enterprise"],
    expiresAt: new Date(Date.now() + 365 * 86400000),
    daysRemaining: 365,
    ver: 1,
    maxUsers: 0,
    ...overrides,
  };
}
