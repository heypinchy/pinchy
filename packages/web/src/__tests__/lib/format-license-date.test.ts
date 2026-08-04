import { describe, it, expect } from "vitest";
import { formatLicenseDate } from "@/lib/format-license-date";

// formatLicenseDate used to be copy-pasted verbatim across three components
// (license-cliff-dialog.tsx, enterprise-banner.tsx, settings-license.tsx —
// issue #1087 dedup sweep). settings-api-keys.tsx has its own, differently
// shaped formatDate (nullable input, "Never" fallback, no format options)
// that is NOT this one — left alone deliberately.
describe("formatLicenseDate", () => {
  it("formats an ISO date as 'Mon D, YYYY'", () => {
    expect(formatLicenseDate("2026-08-15T00:00:00.000Z")).toBe("Aug 15, 2026");
  });

  it("formats a single-digit day without a leading zero", () => {
    expect(formatLicenseDate("2026-01-05T00:00:00.000Z")).toBe("Jan 5, 2026");
  });
});
