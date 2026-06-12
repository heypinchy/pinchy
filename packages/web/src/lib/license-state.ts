import type { LicenseStatus } from "@/lib/license";

/**
 * The four license states of the pricing concept (§ 6), with the expired
 * branch split by key type so trial and paid expiry get their own copy.
 * Derived purely offline from the JWT claims — no network, no telemetry.
 */
export type LicenseState = "community" | "trial" | "trial-expired" | "paid" | "grace" | "expired";

export function deriveLicenseState(status: LicenseStatus, now: Date): LicenseState {
  if (status.expired) {
    return status.type === "trial" ? "trial-expired" : "expired";
  }
  if (!status.active) return "community";
  if (status.type === "trial") return "trial";
  if (status.paidUntilAt && now.getTime() > status.paidUntilAt.getTime()) return "grace";
  return "paid";
}

/**
 * States in which gated features are unlocked. Grace counts as active —
 * the key is still valid (exp = paidUntil + grace, § 1).
 */
export function isLicenseActive(state: LicenseState): boolean {
  return state === "paid" || state === "trial" || state === "grace";
}
