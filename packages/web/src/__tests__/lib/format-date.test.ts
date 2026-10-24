import { describe, it, expect, vi, afterEach } from "vitest";
import { formatLicenseDate } from "@/lib/format-date";

/**
 * `formatLicenseDate` was single-sourced from three byte-identical copies in
 * the #1087 sweep (the enterprise banner, the cliff dialog, the settings
 * license card) and landed without a test of its own. The three components
 * assert their rendered strings, so the format used to be pinned three times
 * indirectly — and after the consolidation, nowhere.
 *
 * The fixtures use midday UTC on purpose. `toLocaleDateString` renders in the
 * machine's zone, so a midnight-UTC input reads as the previous day west of
 * Greenwich: the test would pass in CI (UTC) and fail on a laptop in New York,
 * which would be a property of the fixture rather than of the function.
 */
describe("formatLicenseDate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats an ISO date as 'Mon D, YYYY'", () => {
    expect(formatLicenseDate("2026-08-15T12:00:00.000Z")).toBe("Aug 15, 2026");
  });

  it("writes a single-digit day without a leading zero", () => {
    expect(formatLicenseDate("2026-01-05T12:00:00.000Z")).toBe("Jan 5, 2026");
  });

  it("names the month rather than numbering it", () => {
    expect(formatLicenseDate("2026-09-08T12:00:00.000Z")).toBe("Sep 8, 2026");
  });

  it("asks for en-US explicitly rather than taking the machine's locale", () => {
    // Asserted on the call, not on the output, because the output cannot see
    // this: a runner whose default locale is already en-US — CI's is — renders
    // the same string either way, so dropping the argument would stay green
    // here and turn "Sep 8, 2026" into "8.9.2026" on a de-AT admin's browser.
    // The locale is load-bearing: these three surfaces quote a contractual
    // renewal date back at an admin, and 8/9 vs 9/8 is a real ambiguity.
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString");

    formatLicenseDate("2026-09-08T12:00:00.000Z");

    expect(spy).toHaveBeenCalledWith("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });
});
