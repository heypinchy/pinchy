// Real-DB integration test for POST /api/internal/budgets/check — the question
// pinchy-audit's before_agent_run gate asks before every OpenClaw run.
//
// The unit test mocks the budget lookup, the channel-link lookup and the audit
// writer, so it proves only that the route hands their answers on. What must
// hold for a Telegram turn to be stopped and recorded is SQL: the month's spend
// against a blocking budget, the `channel_links` row that turns a Telegram
// sender into a Pinchy user, and appendAuditLog's pseudonym substitution on that
// user. This runs all three against Postgres. Only the gateway token is stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

import { db } from "@/db";
import { agents, auditLog, channelLinks, costBudgets, usageRecords, users } from "@/db/schema";
import { POST } from "@/app/api/internal/budgets/check/route";

const USER_ID = "Bu6gEtUs3rMixedCase0000000000001";
const PSEUDONYM = "22222222-2222-4222-8222-222222222222";
const TELEGRAM_SENDER = "999888777";

function check(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://pinchy:7777/api/internal/budgets/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer gw-token" },
      body: JSON.stringify(body),
    })
  );
}

async function seedAgent(name: string) {
  const [row] = await db
    .insert(agents)
    .values({ name, model: "anthropic/claude-haiku-5-5", greetingMessage: "Hi" })
    .returning();
  return row;
}

async function spend(agentId: string, usd: string) {
  await db.insert(usageRecords).values({
    userId: USER_ID,
    agentId,
    agentName: "x",
    sessionKey: `agent:${agentId}:telegram:direct:${TELEGRAM_SENDER}`,
    model: "anthropic/claude-haiku-5-5",
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: usd,
  });
}

async function budget(agentId: string | null, limit: string, onExceeded: "notify" | "block") {
  await db.insert(costBudgets).values({ agentId, monthlyLimitUsd: limit, onExceeded });
}

async function refusals() {
  return db
    .select({
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      resource: auditLog.resource,
      detail: auditLog.detail,
      outcome: auditLog.outcome,
    })
    .from(auditLog)
    .where(eq(auditLog.eventType, "chat.policy_refused"));
}

describe("POST /api/internal/budgets/check (real DB)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.insert(users).values({
      id: USER_ID,
      auditPseudonym: PSEUDONYM,
      name: "Budget User",
      email: "budget-user@example.com",
      emailVerified: true,
      role: "member",
    });
    await db
      .insert(channelLinks)
      .values({ userId: USER_ID, channel: "telegram", channelUserId: TELEGRAM_SENDER });
  });

  it("stops a Telegram turn on a used-up blocking budget and records who was refused", async () => {
    const agent = await seedAgent("Knowledge Base");
    await budget(agent.id, "1.00", "block");
    await spend(agent.id, "1.500000");

    const res = await check({
      agentId: agent.id,
      sessionKey: `agent:${agent.id}:telegram:direct:${TELEGRAM_SENDER}`,
      channel: "telegram",
      senderId: TELEGRAM_SENDER,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      blocked: true,
      message:
        "Knowledge Base has used its monthly budget. It's available again next month, or sooner if your admin raises the budget.",
    });
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    // The linked Pinchy user, pseudonymized like every other actor.
    expect(rows[0]).toMatchObject({
      actorType: "user",
      actorId: PSEUDONYM,
      resource: `agent:${agent.id}`,
      outcome: "failure",
      detail: {
        reason: "budget_exhausted",
        agent: { id: agent.id, name: "Knowledge Base" },
        channel: "telegram",
      },
    });
    expect(JSON.stringify(rows[0].detail)).not.toContain(TELEGRAM_SENDER);
  });

  it("lets the turn through when the used-up budget only notifies", async () => {
    const agent = await seedAgent("Notify Only");
    await budget(agent.id, "1.00", "notify");
    await spend(agent.id, "5.000000");

    const res = await check({ agentId: agent.id, channel: "telegram" });

    expect(await res.json()).toEqual({ blocked: false });
    expect(await refusals()).toHaveLength(0);
  });

  it("lets the turn through while the blocking budget still has room", async () => {
    const agent = await seedAgent("Room Left");
    await budget(agent.id, "10.00", "block");
    await spend(agent.id, "9.990000");

    expect(await (await check({ agentId: agent.id })).json()).toEqual({ blocked: false });
  });

  it("stops every agent when the instance's blocking budget is used up", async () => {
    const spender = await seedAgent("Spender");
    const bystander = await seedAgent("Bystander");
    await budget(null, "2.00", "block");
    await spend(spender.id, "2.000000");

    const res = await check({ agentId: bystander.id, channel: "telegram" });

    expect((await res.json()).blocked).toBe(true);
    const rows = await refusals();
    // An unlinked sender: the agent is the actor.
    expect(rows[0]).toMatchObject({ actorType: "agent", actorId: bystander.id });
  });
});
