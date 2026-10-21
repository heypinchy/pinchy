import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

const { getExhaustedBlockingBudgetMock } = vi.hoisted(() => ({
  getExhaustedBlockingBudgetMock: vi.fn(),
}));
vi.mock("@/lib/budgets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budgets")>()),
  getExhaustedBlockingBudget: getExhaustedBlockingBudgetMock,
}));

const { appendAuditLogMock } = vi.hoisted(() => ({ appendAuditLogMock: vi.fn() }));
vi.mock("@/lib/audit", () => ({ appendAuditLog: appendAuditLogMock }));

const { recordAuditFailureMock } = vi.hoisted(() => ({ recordAuditFailureMock: vi.fn() }));
vi.mock("@/lib/audit-deferred", () => ({ recordAuditFailure: recordAuditFailureMock }));

const { agentsFindFirst, usersFindFirst, channelLinksFindFirst } = vi.hoisted(() => ({
  agentsFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
  channelLinksFindFirst: vi.fn(),
}));
vi.mock("@/db", () => ({
  db: {
    query: {
      agents: { findFirst: agentsFindFirst },
      channelLinks: { findFirst: channelLinksFindFirst },
    },
  },
}));
vi.mock("@/lib/user-id-case", () => ({ findUserIdIgnoringCase: usersFindFirst }));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { POST } from "@/app/api/internal/budgets/check/route";

function makeRequest(body: unknown) {
  return new NextRequest("http://pinchy:7777/api/internal/budgets/check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer gw-token" },
    body: JSON.stringify(body),
  });
}

const AGENT = { id: "agent-1", name: "Knowledge Base" };

function agentBudget() {
  return {
    id: "budget-1",
    agent: { id: AGENT.id, name: AGENT.name },
    monthlyLimitUsd: 100,
    onExceeded: "block" as const,
    spentUsd: 101,
    period: "2026-10",
    state: "exceeded" as const,
  };
}

describe("POST /api/internal/budgets/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    agentsFindFirst.mockResolvedValue(AGENT);
    usersFindFirst.mockResolvedValue(undefined);
    channelLinksFindFirst.mockResolvedValue(undefined);
    getExhaustedBlockingBudgetMock.mockResolvedValue(null);
  });

  it("rejects a request without the gateway token", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);
    const res = await POST(makeRequest({ agentId: AGENT.id }));
    expect(res.status).toBe(401);
    expect(getExhaustedBlockingBudgetMock).not.toHaveBeenCalled();
  });

  it("rejects a body without an agentId", async () => {
    const res = await POST(makeRequest({ channel: "telegram" }));
    expect(res.status).toBe(400);
  });

  it("passes an agent with no exhausted blocking budget, and writes nothing", async () => {
    const res = await POST(makeRequest({ agentId: AGENT.id, channel: "telegram" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blocked: false });
    expect(getExhaustedBlockingBudgetMock).toHaveBeenCalledWith(AGENT.id);
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("blocks an agent whose own blocking budget is used up, with the sentence the browser shows", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    const res = await POST(makeRequest({ agentId: AGENT.id, channel: "telegram" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      blocked: true,
      message:
        "Knowledge Base has used its monthly budget. It's available again next month, or sooner if your admin raises the budget.",
    });
  });

  it("names the instance when it is the instance budget that is used up", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue({ ...agentBudget(), agent: null });
    const res = await POST(makeRequest({ agentId: AGENT.id }));
    const body = await res.json();
    expect(body.message).toBe(
      "This Pinchy has used its monthly budget. Agents are available again next month, or sooner if your admin raises the budget."
    );
  });

  it("audits a refusal as chat.policy_refused with the reason, the budget and the channel", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    await POST(makeRequest({ agentId: AGENT.id, channel: "telegram", trigger: "user" }));
    expect(appendAuditLogMock).toHaveBeenCalledTimes(1);
    expect(appendAuditLogMock).toHaveBeenCalledWith({
      actorType: "agent",
      actorId: AGENT.id,
      eventType: "chat.policy_refused",
      resource: `agent:${AGENT.id}`,
      detail: {
        reason: "budget_exhausted",
        agent: { id: AGENT.id, name: AGENT.name },
        budget: { id: "budget-1", period: "2026-10" },
        channel: "telegram",
        trigger: "user",
      },
      outcome: "failure",
    });
  });

  it("attributes a Telegram refusal to the Pinchy user the sender's account is linked to", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    channelLinksFindFirst.mockResolvedValue({ userId: "User-Abc" });
    await POST(makeRequest({ agentId: AGENT.id, channel: "telegram", senderId: "999888777" }));
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "user", actorId: "User-Abc" })
    );
    // The Telegram account id is the sender's identity on another service —
    // the actor column already says who it was, so it stays out of detail.
    expect(JSON.stringify(appendAuditLogMock.mock.calls[0][0].detail)).not.toContain("999888777");
  });

  it("attributes a direct-session refusal to the user in the session key, in their real case", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    // OpenClaw lowercases session keys; users.id is mixed case.
    usersFindFirst.mockResolvedValue("User-Abc");
    await POST(
      makeRequest({ agentId: AGENT.id, sessionKey: `agent:${AGENT.id}:direct:user-abc:chat-1` })
    );
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "user", actorId: "User-Abc" })
    );
  });

  it("still applies the instance budget to an agent Pinchy does not know", async () => {
    agentsFindFirst.mockResolvedValue(undefined);
    getExhaustedBlockingBudgetMock.mockResolvedValue({ ...agentBudget(), agent: null });
    const res = await POST(makeRequest({ agentId: "main" }));
    expect((await res.json()).blocked).toBe(true);
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "agent:main",
        detail: expect.objectContaining({ agent: { id: "main", name: "main" } }),
      })
    );
  });

  it("still answers blocked when the audit write fails, and records the failure", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    appendAuditLogMock.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest({ agentId: AGENT.id }));
    expect((await res.json()).blocked).toBe(true);
    expect(recordAuditFailureMock).toHaveBeenCalledTimes(1);
  });

  it("still blocks when the actor lookup fails, attributing the refusal to the agent", async () => {
    // The plugin lets a run through on any error answer, so a lookup that only
    // shapes the audit row must never turn a block into a 500.
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    channelLinksFindFirst.mockRejectedValue(new Error("pool timeout"));
    const res = await POST(
      makeRequest({ agentId: AGENT.id, channel: "telegram", senderId: "999888777" })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).blocked).toBe(true);
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "agent", actorId: AGENT.id })
    );
  });

  it("still blocks when the agent lookup fails, naming the agent by its id", async () => {
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    agentsFindFirst.mockRejectedValue(new Error("pool timeout"));
    const res = await POST(makeRequest({ agentId: AGENT.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      blocked: true,
      message: `${AGENT.id} has used its monthly budget. It's available again next month, or sooner if your admin raises the budget.`,
    });
  });

  it("drops malformed audit details instead of refusing the check", async () => {
    // A 400 would read as "Pinchy unreachable" in the plugin and let every
    // run through — a budget switched off by an audit detail.
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    const res = await POST(
      makeRequest({
        agentId: AGENT.id,
        sessionKey: "x".repeat(600),
        channel: null,
        senderId: 999888777,
        trigger: "user",
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).blocked).toBe(true);
    expect(appendAuditLogMock.mock.calls[0][0].detail).toEqual({
      reason: "budget_exhausted",
      agent: { id: AGENT.id, name: AGENT.name },
      budget: { id: "budget-1", period: "2026-10" },
      trigger: "user",
    });
  });

  it("prefers the linked channel account over a direct-looking session key", async () => {
    // dmScope "per-peer" gives a Telegram DM a key shaped like a direct one,
    // but its last segment is the Telegram peer, not a Pinchy user.
    getExhaustedBlockingBudgetMock.mockResolvedValue(agentBudget());
    channelLinksFindFirst.mockResolvedValue({ userId: "User-Abc" });
    await POST(
      makeRequest({
        agentId: AGENT.id,
        sessionKey: `agent:${AGENT.id}:direct:999888777`,
        channel: "telegram",
        senderId: "999888777",
      })
    );
    expect(usersFindFirst).not.toHaveBeenCalled();
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "user", actorId: "User-Abc" })
    );
  });
});
