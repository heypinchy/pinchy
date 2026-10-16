// Real-DB tests for monthly cost budgets (#36). The load-bearing parts are SQL:
// the month window in the ORG timezone, NULL-cost rows, and an alert claim that
// must fire exactly once per budget and month even across two sweeps. Mocking
// @/db would assert none of that.
//
// Only the audit writer is mocked — its HMAC chain is covered elsewhere, and
// what matters here is which rows the claim decides to write.
import { describe, it, expect, vi, beforeEach } from "vitest";

import { db } from "@/db";
import { agents, usageRecords, costBudgets } from "@/db/schema";
import { setOrgTimezone } from "@/lib/settings-timezone";

const { appendAuditLogMock } = vi.hoisted(() => ({ appendAuditLogMock: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: appendAuditLogMock,
}));

import {
  getBudgetStatuses,
  getExhaustedBlockingBudget,
  getBlockedByBudgets,
  evaluateBudgetAlerts,
} from "@/lib/budgets";

// Mid-October 2026, UTC. Vienna is UTC+2 until 2026-10-25.
const NOW = new Date("2026-10-16T10:00:00.000Z");

async function seedAgent(name: string) {
  const [row] = await db
    .insert(agents)
    .values({ name, model: "anthropic/claude-haiku-5-5", greetingMessage: "Hi" })
    .returning();
  return row;
}

async function spend(agentId: string, usd: string | null, at: string) {
  await db.insert(usageRecords).values({
    timestamp: new Date(at),
    userId: "user-1",
    agentId,
    agentName: "x",
    sessionKey: `agent:${agentId}:direct:user-1`,
    model: "anthropic/claude-haiku-5-5",
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: usd,
  });
}

async function budget(
  agentId: string | null,
  limit: string,
  onExceeded: "notify" | "block" = "notify"
) {
  const [row] = await db
    .insert(costBudgets)
    .values({ agentId, monthlyLimitUsd: limit, onExceeded })
    .returning();
  return row;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await setOrgTimezone("Europe/Vienna");
});

describe("getBudgetStatuses", () => {
  it("sums the instance's spend since the start of the month in the org timezone", async () => {
    const a = await seedAgent("Ava");
    const b = await seedAgent("Bo");
    await spend(a.id, "3.000000", "2026-10-02T09:00:00.000Z");
    await spend(b.id, "2.500000", "2026-10-15T09:00:00.000Z");
    // 00:30 on 1 October in Vienna, still 30 September in UTC: October.
    await spend(a.id, "1.000000", "2026-09-30T22:30:00.000Z");
    // 23:30 on 30 September in Vienna: September, not counted.
    await spend(a.id, "100.000000", "2026-09-30T21:30:00.000Z");
    await budget(null, "10.00");

    const [status] = await getBudgetStatuses({ now: NOW });

    expect(status).toMatchObject({
      agent: null,
      period: "2026-10",
      monthlyLimitUsd: 10,
      spentUsd: 6.5,
      state: "ok",
    });
  });

  it("counts only the budget's own agent, and treats a row with no price as free", async () => {
    const a = await seedAgent("Ava");
    const b = await seedAgent("Bo");
    await spend(a.id, "4.000000", "2026-10-05T09:00:00.000Z");
    await spend(a.id, null, "2026-10-06T09:00:00.000Z");
    await spend(b.id, "50.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00");

    const [status] = await getBudgetStatuses({ now: NOW });

    expect(status).toMatchObject({
      agent: { id: a.id, name: "Ava" },
      spentUsd: 4,
      state: "warning",
    });
  });

  it("calls a budget exceeded once spend reaches its limit", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "5.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00");

    const [status] = await getBudgetStatuses({ now: NOW });

    expect(status.state).toBe("exceeded");
  });
});

describe("getExhaustedBlockingBudget", () => {
  it("names the agent's own exhausted blocking budget", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "6.000000", "2026-10-05T09:00:00.000Z");
    const row = await budget(a.id, "5.00", "block");

    await expect(getExhaustedBlockingBudget(a.id, { now: NOW })).resolves.toMatchObject({
      id: row.id,
    });
  });

  it("ignores an exhausted budget that only notifies", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "6.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00", "notify");

    await expect(getExhaustedBlockingBudget(a.id, { now: NOW })).resolves.toBeNull();
  });

  it("applies an exhausted blocking instance budget to every agent", async () => {
    const a = await seedAgent("Ava");
    const b = await seedAgent("Bo");
    await spend(a.id, "11.000000", "2026-10-05T09:00:00.000Z");
    await budget(null, "10.00", "block");

    await expect(getExhaustedBlockingBudget(b.id, { now: NOW })).resolves.toMatchObject({
      agent: null,
    });
  });

  it("lifts the block when the month rolls over", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "6.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00", "block");

    await expect(
      getExhaustedBlockingBudget(a.id, { now: new Date("2026-11-02T10:00:00.000Z") })
    ).resolves.toBeNull();
  });
});

describe("getBlockedByBudgets", () => {
  it("lists the agents a blocking budget has stopped, and whether the instance is stopped", async () => {
    const a = await seedAgent("Ava");
    const b = await seedAgent("Bo");
    await spend(a.id, "6.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00", "block");
    await budget(b.id, "5.00", "block");

    const blocked = await getBlockedByBudgets({ now: NOW });

    expect(blocked.instance).toBe(false);
    expect([...blocked.agentIds]).toEqual([a.id]);
  });
});

describe("evaluateBudgetAlerts", () => {
  it("audits the 80% crossing exactly once per month, however many sweeps see it", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "4.200000", "2026-10-05T09:00:00.000Z");
    const row = await budget(a.id, "5.00");

    await evaluateBudgetAlerts({ now: NOW });
    await evaluateBudgetAlerts({ now: NOW });

    expect(appendAuditLogMock).toHaveBeenCalledTimes(1);
    expect(appendAuditLogMock).toHaveBeenCalledWith({
      actorType: "system",
      actorId: "budget-monitor",
      eventType: "budget.threshold_reached",
      resource: `budget:${row.id}`,
      outcome: "success",
      detail: {
        budget: { id: row.id, scope: "agent", agent: { id: a.id, name: "Ava" } },
        period: "2026-10",
        thresholdPercent: 80,
        spentUsd: 4.2,
        limitUsd: 5,
        onExceeded: "notify",
      },
    });
  });

  it("audits the 100% crossing separately, naming the action that now applies", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "5.500000", "2026-10-05T09:00:00.000Z");
    await budget(null, "5.00", "block");

    await evaluateBudgetAlerts({ now: NOW });

    const events = appendAuditLogMock.mock.calls.map(([entry]) => entry.eventType);
    expect(events.sort()).toEqual(["budget.exceeded", "budget.threshold_reached"]);
    const exceeded = appendAuditLogMock.mock.calls.find(
      ([entry]) => entry.eventType === "budget.exceeded"
    )![0];
    expect(exceeded.detail).toMatchObject({
      budget: { scope: "instance" },
      thresholdPercent: 100,
      onExceeded: "block",
    });
  });

  it("re-arms in the next month", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "4.200000", "2026-10-05T09:00:00.000Z");
    await spend(a.id, "4.200000", "2026-11-03T09:00:00.000Z");
    await budget(a.id, "5.00");

    await evaluateBudgetAlerts({ now: NOW });
    await evaluateBudgetAlerts({ now: new Date("2026-11-10T10:00:00.000Z") });

    const periods = appendAuditLogMock.mock.calls.map(([entry]) => entry.detail.period);
    expect(periods).toEqual(["2026-10", "2026-11"]);
  });

  it("writes nothing for a budget below its warning line", async () => {
    const a = await seedAgent("Ava");
    await spend(a.id, "1.000000", "2026-10-05T09:00:00.000Z");
    await budget(a.id, "5.00");

    await evaluateBudgetAlerts({ now: NOW });

    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });
});
