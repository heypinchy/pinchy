/**
 * Render an ISO date the way every license-lifecycle surface renders it
 * ("Aug 4, 2026") — the settings panel, the banner, and the cliff dialog.
 *
 * The locale is pinned to "en-US" rather than the visitor's, deliberately and
 * as it always was here: these three surfaces quote a contractual date back to
 * an admin, and the machine's locale deciding between 4/8 and 8/4 is a real
 * ambiguity on a renewal deadline. Pinchy's UI copy is English throughout
 * (PERSONALITY.md), so a month name is unambiguous for the reader it has.
 *
 * Single-sourced from three byte-identical copies (#1087): a date format that
 * drifts between the banner and the panel below it reads as two different
 * dates for one license.
 */
export function formatLicenseDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
