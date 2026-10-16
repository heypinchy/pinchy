import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, costBudgets, usageRecords } from "@/db/schema";
import type { BudgetAction } from "@/db/enums";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { getOrgTimezone } from "@/lib/settings-timezone";

/**
 * Monthly cost budgets (#36): a USD limit on what `usage_records` says an agent
 * — or the whole instance — has spent this calendar month, in the org
 * timezone. Design of record: plans/2026-10-16-cost-governance-design.md.
 *
 * Spend is `estimated_cost_usd`, priced when each turn was recorded. Rows with
 * no price (knowledge-base OCR, plugin vision) count as free, Ollama models are
 * priced at 0, and a row counts in the month it was RECORDED — all stated in
 * the docs, because a budget that reads lower than the invoice is a promise the
 * product cannot keep silently.
 */

/** Share of the limit at which admins are warned. */
export const WARNING_RATIO = 0.8;

export type BudgetState = "ok" | "warning" | "exceeded";

export interface BudgetStatus {
  id: string;
  /** The agent this budget caps; `null` for the instance-wide budget. */
  agent: { id: string; name: string } | null;
  monthlyLimitUsd: number;
  onExceeded: BudgetAction;
  spentUsd: number;
  /** 'YYYY-MM' in the org timezone — the month this status is about. */
  period: string;
  state: BudgetState;
}

/** `now` is injectable so the month boundary can be tested; it defaults to the clock. */
export interface BudgetClock {
  now?: Date;
}

export function budgetState(spentUsd: number, limitUsd: number): BudgetState {
  if (spentUsd >= limitUsd) return "exceeded";
  if (spentUsd >= limitUsd * WARNING_RATIO) return "warning";
  return "ok";
}

/**
 * The current month in the org timezone: its 'YYYY-MM' label and the instant
 * it began. Computed by Postgres, which knows every IANA zone's rules —
 * including the DST shift that makes "midnight on the 1st" a different UTC
 * offset in March and in October.
 */
async function currentPeriod(now: Date): Promise<{ period: string; start: Date; end: Date }> {
  const tz = await getOrgTimezone();
  const at = now.toISOString();
  const [row] = (await db.execute(sql`
    SELECT
      to_char(${at}::timestamptz AT TIME ZONE ${tz}, 'YYYY-MM') AS period,
      (date_trunc('month', ${at}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start,
      ((date_trunc('month', ${at}::timestamptz AT TIME ZONE ${tz}) + interval '1 month')
        AT TIME ZONE ${tz}) AS "end"
  `)) as unknown as { period: string; start: string | Date; end: string | Date }[];
  return { period: row.period, start: new Date(row.start), end: new Date(row.end) };
}

const spentSql = sql<string>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)`;

export async function getBudgetStatuses({ now = new Date() }: BudgetClock = {}): Promise<
  BudgetStatus[]
> {
  const rows = await db
    .select({
      id: costBudgets.id,
      agentId: costBudgets.agentId,
      agentName: agents.name,
      monthlyLimitUsd: costBudgets.monthlyLimitUsd,
      onExceeded: costBudgets.onExceeded,
    })
    .from(costBudgets)
    .leftJoin(agents, eq(agents.id, costBudgets.agentId));
  if (rows.length === 0) return [];

  const { period, start, end } = await currentPeriod(now);
  const inPeriod = and(gte(usageRecords.timestamp, start), lt(usageRecords.timestamp, end));

  const agentIds = rows.flatMap((r) => (r.agentId ? [r.agentId] : []));
  const perAgent = agentIds.length
    ? await db
        .select({ agentId: usageRecords.agentId, spent: spentSql })
        .from(usageRecords)
        .where(and(inPeriod, inArray(usageRecords.agentId, agentIds)))
        .groupBy(usageRecords.agentId)
    : [];
  const spentByAgent = new Map(perAgent.map((r) => [r.agentId, Number(r.spent)]));

  const instanceSpent = rows.some((r) => r.agentId === null)
    ? Number((await db.select({ spent: spentSql }).from(usageRecords).where(inPeriod))[0].spent)
    : 0;

  return rows.map((r) => {
    const monthlyLimitUsd = Number(r.monthlyLimitUsd);
    const spentUsd = r.agentId ? (spentByAgent.get(r.agentId) ?? 0) : instanceSpent;
    return {
      id: r.id,
      agent: r.agentId ? { id: r.agentId, name: r.agentName ?? "(deleted)" } : null,
      monthlyLimitUsd,
      onExceeded: r.onExceeded,
      spentUsd,
      period,
      state: budgetState(spentUsd, monthlyLimitUsd),
    };
  });
}

function isBlocking(status: BudgetStatus): boolean {
  return status.state === "exceeded" && status.onExceeded === "block";
}

/**
 * The exhausted, blocking budget that stops `agentId` right now — its own, or
 * the instance's — or null. Only budgets that can apply are loaded, so an
 * instance without budgets pays one indexed lookup per send.
 */
export async function getExhaustedBlockingBudget(
  agentId: string,
  clock: BudgetClock = {}
): Promise<BudgetStatus | null> {
  const applicable = await db
    .select({ id: costBudgets.id })
    .from(costBudgets)
    .where(
      and(
        eq(costBudgets.onExceeded, "block"),
        or(isNull(costBudgets.agentId), eq(costBudgets.agentId, agentId))
      )
    );
  if (applicable.length === 0) return null;

  const statuses = await getBudgetStatuses(clock);
  return (
    statuses.find((s) => isBlocking(s) && (s.agent === null || s.agent.id === agentId)) ?? null
  );
}

/** Which agents blocking budgets have stopped this month — for the automation sweep. */
export async function getBlockedByBudgets(
  clock: BudgetClock = {}
): Promise<{ instance: boolean; agentIds: Set<string> }> {
  const blocking = (await getBudgetStatuses(clock)).filter(isBlocking);
  return {
    instance: blocking.some((s) => s.agent === null),
    agentIds: new Set(blocking.flatMap((s) => (s.agent ? [s.agent.id] : []))),
  };
}

/**
 * Claim this month's alert for one budget: set the period column unless it
 * already holds this month. Only the caller whose UPDATE returned the row may
 * write the audit entry, so two sweeps — or a restart mid-sweep — never repeat
 * an alert.
 */
async function claimAlert(
  budgetId: string,
  column: "warned_period" | "exceeded_period",
  period: string
): Promise<boolean> {
  const claimed = (await db.execute(sql`
    UPDATE cost_budgets
    SET ${sql.raw(column)} = ${period}
    WHERE id = ${budgetId} AND ${sql.raw(column)} IS DISTINCT FROM ${period}
    RETURNING id
  `)) as unknown as { id: string }[];
  return claimed.length > 0;
}

/**
 * Write `budget.threshold_reached` (80%) and `budget.exceeded` (100%) for every
 * budget that crossed a line this month and has not been reported for it yet.
 * Runs after each usage sweep, so an alert lands within a minute of the turn
 * that crossed the line.
 */
export async function evaluateBudgetAlerts(clock: BudgetClock = {}): Promise<void> {
  for (const status of await getBudgetStatuses(clock)) {
    if (status.state === "ok") continue;
    const crossings: Array<{
      column: "warned_period" | "exceeded_period";
      eventType: "budget.threshold_reached" | "budget.exceeded";
      thresholdPercent: 80 | 100;
    }> = [{ column: "warned_period", eventType: "budget.threshold_reached", thresholdPercent: 80 }];
    if (status.state === "exceeded") {
      crossings.push({
        column: "exceeded_period",
        eventType: "budget.exceeded",
        thresholdPercent: 100,
      });
    }

    for (const crossing of crossings) {
      if (!(await claimAlert(status.id, crossing.column, status.period))) continue;
      const entry = {
        actorType: "system" as const,
        actorId: "budget-monitor",
        eventType: crossing.eventType,
        resource: `budget:${status.id}`,
        outcome: "success" as const,
        detail: {
          budget: status.agent
            ? { id: status.id, scope: "agent" as const, agent: status.agent }
            : { id: status.id, scope: "instance" as const },
          period: status.period,
          thresholdPercent: crossing.thresholdPercent,
          spentUsd: status.spentUsd,
          limitUsd: status.monthlyLimitUsd,
          onExceeded: status.onExceeded,
        },
      };
      // A background sweep: an audit outage must not stop the next budget's
      // check, and the claim already happened, so the write is kept for retry.
      try {
        await appendAuditLog(entry);
      } catch (err) {
        recordAuditFailure(err, entry);
      }
    }
  }
}
