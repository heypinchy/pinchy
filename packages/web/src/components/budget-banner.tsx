"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { apiGet } from "@/lib/api-client";
import type { BudgetStatus } from "@/lib/budgets";
import { budgetPercent, formatUsd } from "@/lib/budget-format";

const REFETCH_INTERVAL_MS = 5 * 60 * 1000;
const DISMISS_PREFIX = "pinchy-banner-dismissed:";

function message(budget: BudgetStatus): string {
  const who = budget.agent?.name ?? "This Pinchy";
  const amounts = `(${formatUsd(budget.spentUsd)} of ${formatUsd(budget.monthlyLimitUsd)})`;
  if (budget.state === "exceeded") {
    return budget.onExceeded === "block"
      ? `${who} has used its monthly budget ${amounts}. New chats and automations are paused until next month.`
      : `${who} has used its monthly budget ${amounts}.`;
  }
  const percent = budgetPercent(budget.spentUsd, budget.monthlyLimitUsd);
  return `${who} has used ${percent}% of its monthly budget ${amounts}.`;
}

/** Dismissal is per budget, month and state: crossing 100% shows it again. */
const dismissKey = (b: BudgetStatus) => `${DISMISS_PREFIX}budget:${b.id}:${b.period}:${b.state}`;

function isDismissed(b: BudgetStatus): boolean {
  try {
    return sessionStorage.getItem(dismissKey(b)) === "1";
  } catch {
    return false;
  }
}

/**
 * The admin's warning that a cost budget (#36) has passed 80% this month, or
 * been used up. Sits beside the license banner; the budget monitor writes the
 * matching `budget.*` audit rows independently of whether anyone sees this.
 */
export function BudgetBanner({ isAdmin }: { isAdmin: boolean }) {
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [, setDismissTick] = useState(0);

  const fetchBudgets = useCallback(() => {
    apiGet<BudgetStatus[]>("/api/budgets")
      .then((list) => setBudgets(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetchBudgets();
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchBudgets();
    };
    const interval = setInterval(fetchBudgets, REFETCH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAdmin, fetchBudgets]);

  if (!isAdmin) return null;

  const shown = budgets.filter((b) => b.state !== "ok" && !isDismissed(b));
  if (shown.length === 0) return null;

  const dismiss = (b: BudgetStatus) => {
    try {
      sessionStorage.setItem(dismissKey(b), "1");
    } catch {
      // Storage unavailable: the bar hides for this render only.
    }
    setDismissTick((t) => t + 1);
  };

  return (
    <div data-testid="budget-banner">
      {shown.map((budget) => (
        <div
          key={budget.id}
          role="alert"
          className={`relative px-8 py-2 text-sm text-center ${
            budget.state === "exceeded"
              ? "bg-amber-500 text-white"
              : "bg-muted text-foreground border-b"
          }`}
        >
          {message(budget)}{" "}
          <Link href="/usage" className="underline font-medium">
            Review budgets
          </Link>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(budget)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
