/**
 * How cost budgets (#36) are shown — shared by the Budgets card and the admin
 * banner so both say the same number the same way. Client-safe: no imports.
 */

export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

/** Share of the limit spent, rounded down so 79.9% never reads as the 80% line. */
export function budgetPercent(spentUsd: number, limitUsd: number): number {
  return Math.floor((spentUsd / limitUsd) * 100);
}
