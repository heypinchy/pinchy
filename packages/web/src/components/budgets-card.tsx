"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { EnterpriseFeatureCard } from "@/components/enterprise-feature-card";
import { apiDelete, apiGet, apiPut, errorMessage } from "@/lib/api-client";
import type { UpsertBudgetInput } from "@/lib/schemas/budgets";
import type { BudgetStatus } from "@/lib/budgets";
import { budgetPercent, formatUsd } from "@/lib/budget-format";
import type { LicenseState } from "@/lib/license-state";

const INSTANCE = "__instance__";

function stateLabel(budget: BudgetStatus): string {
  const percent = budgetPercent(budget.spentUsd, budget.monthlyLimitUsd);
  if (budget.state === "exceeded") {
    return budget.onExceeded === "block"
      ? `${percent}% — new chats paused until next month`
      : `${percent}% — over budget`;
  }
  return `${percent}%`;
}

/**
 * Monthly cost budgets (#36) on the Usage page: one for the whole instance,
 * one per agent. Setting one is an Enterprise feature; removing one never is,
 * so a lapsed license cannot strand an instance whose chats a budget stopped.
 */
export function BudgetsCard({
  isEnterprise,
  licenseState,
  licensePeriodEnd,
}: {
  isEnterprise: boolean;
  licenseState?: LicenseState;
  licensePeriodEnd?: string | null;
}) {
  const [budgets, setBudgets] = useState<BudgetStatus[] | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [scope, setScope] = useState(INSTANCE);
  const [limit, setLimit] = useState("");
  const [onExceeded, setOnExceeded] = useState<UpsertBudgetInput["onExceeded"]>("notify");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBudgets(await apiGet<BudgetStatus[]>("/api/budgets"));
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't load budgets"));
      setBudgets([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    if (isEnterprise) {
      apiGet<Array<{ id: string; name: string }>>("/api/agents")
        .then((list) => {
          if (!cancelled) setAgents(list.map((a) => ({ id: a.id, name: a.name })));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [load, isEnterprise]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await apiPut<unknown, UpsertBudgetInput>("/api/budgets", {
        agentId: scope === INSTANCE ? null : scope,
        monthlyLimitUsd: Number(limit),
        onExceeded,
      });
      toast.success("Budget saved");
      setLimit("");
      await load();
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the budget"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(budget: BudgetStatus) {
    try {
      await apiDelete(`/api/budgets/${budget.id}`);
      toast.success("Budget removed");
      await load();
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't remove the budget"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          A monthly limit on estimated spend, for the whole instance or one agent. You&apos;re
          warned at 80%. At 100% a budget either just tells you, or pauses new chats and automations
          until the month is over.
        </p>

        {budgets && budgets.length > 0 && (
          <ul className="space-y-4">
            {budgets.map((budget) => (
              <li key={budget.id} data-testid={`budget-${budget.id}`} className="space-y-1">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium">{budget.agent?.name ?? "Whole instance"}</span>
                  <span className="text-muted-foreground">{stateLabel(budget)}</span>
                </div>
                <Progress
                  value={Math.min(100, (budget.spentUsd / budget.monthlyLimitUsd) * 100)}
                  className={budget.state === "ok" ? undefined : "bg-amber-500/20"}
                />
                <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                  <span>
                    {formatUsd(budget.spentUsd)} of {formatUsd(budget.monthlyLimitUsd)} this month
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => handleRemove(budget)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {isEnterprise ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem_12rem_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="budget-scope">Applies to</Label>
              <select
                id="budget-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value={INSTANCE}>Whole instance</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-limit">Monthly limit (USD)</Label>
              <Input
                id="budget-limit"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-action">When it&apos;s used up</Label>
              <select
                id="budget-action"
                value={onExceeded}
                onChange={(e) => setOnExceeded(e.target.value as UpsertBudgetInput["onExceeded"])}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="notify">Just tell me</option>
                <option value="block">Pause chats and automations</option>
              </select>
            </div>
            <Button onClick={handleSave} disabled={saving || limit === ""}>
              {saving ? "Saving..." : "Save budget"}
            </Button>
            {error && <p className="text-sm text-destructive sm:col-span-4">{error}</p>}
          </div>
        ) : (
          <EnterpriseFeatureCard
            feature="Cost Budgets"
            description="Cap what the instance or a single agent may spend each month, get warned at 80%, and pause new chats when a budget is used up."
            campaign="analytics"
            isAdmin
            licenseState={licenseState}
            periodEnd={licensePeriodEnd}
          />
        )}
      </CardContent>
    </Card>
  );
}
