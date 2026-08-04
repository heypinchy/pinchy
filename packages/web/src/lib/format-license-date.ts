/**
 * "Mon D, YYYY" date formatting shared by the three license-lifecycle UI
 * surfaces (issue #1087 dedup sweep): the cliff dialog, the enterprise
 * banner, and the settings license card. All three format the same kind of
 * value — a license claim's ISO date string (paidUntilAt, trialEndsAt,
 * expiresAt) — for the same factual, no-countdown copy the pricing concept
 * § 6 calls for.
 */
export function formatLicenseDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
