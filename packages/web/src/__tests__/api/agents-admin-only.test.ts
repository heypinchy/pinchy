import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const getSession = vi.fn();
  return { getSession, auth: { api: { getSession } } };
});

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn(),
}));

vi.mock("@/lib/admin-only-agents", () => ({
  listAdminOnlyAgents: vi.fn(),
  openAdminOnlyAgentsToAll: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

import { getSession } from "@/lib/auth";
import { isEnterprise } from "@/lib/enterprise";
import { listAdminOnlyAgents, openAdminOnlyAgentsToAll } from "@/lib/admin-only-agents";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { mockSession } from "@/test-helpers/auth";
import { makeNextRequest, routeContext } from "@/test-helpers/route";
import { GET } from "@/app/api/agents/admin-only/route";
import { POST } from "@/app/api/agents/admin-only/open-to-all/route";

function postBody(body: unknown) {
  return makeNextRequest("http://localhost/api/agents/admin-only/open-to-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(mockSession());
  vi.mocked(isEnterprise).mockResolvedValue(true);
});

describe("GET /api/agents/admin-only", () => {
  it("lists the shared agents only admins can use", async () => {
    vi.mocked(listAdminOnlyAgents).mockResolvedValue([{ id: "a1", name: "Sales Bot" }]);

    const res = await GET(makeNextRequest(), routeContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [{ id: "a1", name: "Sales Bot" }] });
  });

  it("answers on a community instance too — the admin should know before activating", async () => {
    vi.mocked(isEnterprise).mockResolvedValue(false);
    vi.mocked(listAdminOnlyAgents).mockResolvedValue([{ id: "a1", name: "Sales Bot" }]);

    const res = await GET(makeNextRequest(), routeContext());

    expect(res.status).toBe(200);
  });

  it("is admin-only", async () => {
    vi.mocked(getSession).mockResolvedValue(mockSession({ user: { role: "member" } }));

    const res = await GET(makeNextRequest(), routeContext());

    expect(res.status).toBe(403);
    expect(listAdminOnlyAgents).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/admin-only/open-to-all", () => {
  it("opens the named agents to everyone and audits each one as a visibility change", async () => {
    vi.mocked(openAdminOnlyAgentsToAll).mockResolvedValue([
      { id: "a1", name: "Sales Bot" },
      { id: "a2", name: "HR Bot" },
    ]);

    const res = await POST(postBody({ agentIds: ["a1", "a2"] }), routeContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agents: [
        { id: "a1", name: "Sales Bot" },
        { id: "a2", name: "HR Bot" },
      ],
    });
    expect(openAdminOnlyAgentsToAll).toHaveBeenCalledWith(["a1", "a2"]);
    expect(appendAuditLog).toHaveBeenCalledTimes(2);
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.updated",
      resource: "agent:a1",
      detail: {
        name: "Sales Bot",
        changes: { visibility: { from: "restricted", to: "all" } },
      },
      outcome: "success",
    });
    expect(recalculateTelegramAllowStores).toHaveBeenCalled();
  });

  it("audits before recalculating Telegram stores — a recalc failure must not lose the trail", async () => {
    vi.mocked(openAdminOnlyAgentsToAll).mockResolvedValue([{ id: "a1", name: "Sales Bot" }]);
    const order: string[] = [];
    vi.mocked(appendAuditLog).mockImplementation(async () => {
      order.push("audit");
      return { id: 1, rowHmac: "hmac" };
    });
    vi.mocked(recalculateTelegramAllowStores).mockImplementation(async () => {
      order.push("telegram");
    });

    await POST(postBody({ agentIds: ["a1"] }), routeContext());

    expect(order).toEqual(["audit", "telegram"]);
  });

  it("writes nothing when no named agent was still admin-only", async () => {
    vi.mocked(openAdminOnlyAgentsToAll).mockResolvedValue([]);

    const res = await POST(postBody({ agentIds: ["a1"] }), routeContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(recalculateTelegramAllowStores).not.toHaveBeenCalled();
  });

  it("refuses without an active license — visibility is a licensed setting", async () => {
    vi.mocked(isEnterprise).mockResolvedValue(false);

    const res = await POST(postBody({ agentIds: ["a1"] }), routeContext());

    expect(res.status).toBe(403);
    expect(openAdminOnlyAgentsToAll).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    vi.mocked(getSession).mockResolvedValue(mockSession({ user: { role: "member" } }));

    const res = await POST(postBody({ agentIds: ["a1"] }), routeContext());

    expect(res.status).toBe(403);
    expect(openAdminOnlyAgentsToAll).not.toHaveBeenCalled();
  });

  it("rejects an empty selection", async () => {
    const res = await POST(postBody({ agentIds: [] }), routeContext());

    expect(res.status).toBe(400);
    expect(openAdminOnlyAgentsToAll).not.toHaveBeenCalled();
  });
});
