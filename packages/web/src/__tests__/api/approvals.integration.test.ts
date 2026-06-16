/**
 * Approval routes against a real PostgreSQL — the gate-check security boundary,
 * the requester's pending list, and the self-confirm decision endpoint, with
 * their audit lifecycle. Only the auth boundary (getSession) is mocked; the DB
 * and audit writes are real.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

import { db } from "@/db";
import { users, agents, toolApproval, auditLog } from "@/db/schema";
import { POST as gateCheck } from "@/app/api/internal/approvals/gate-check/route";
import { GET as listApprovals } from "@/app/api/approvals/route";
import { POST as decide } from "@/app/api/approvals/[id]/decision/route";

const GW = "test-gw-token";
beforeAll(() => {
  process.env.PINCHY_E2E_GATEWAY_TOKEN = GW;
});

let emailSeq = 0;
async function seedUser(role: "admin" | "member" = "member") {
  const [u] = await db
    .insert(users)
    .values({ name: "U", email: `u${emailSeq++}@example.com`, emailVerified: true, role })
    .returning();
  return u;
}
async function seedAgent(ownerId: string, confirmTools: string[] = ["odoo_write"]) {
  const [a] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hi",
      ownerId,
      pluginConfig: { "pinchy-approvals": { confirmTools } },
    })
    .returning();
  return a;
}
function gateReq(body: object, token: string | null = GW) {
  return new NextRequest("http://localhost/api/internal/approvals/gate-check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
function decideReq(body: object) {
  return new NextRequest("http://localhost/api/approvals/x/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function setSession(user: { id: string; role?: string }) {
  mockGetSession.mockResolvedValue({
    user: { id: user.id, role: user.role ?? "member", name: "U" },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("approval routes (integration, real DB)", () => {
  let user: Awaited<ReturnType<typeof seedUser>>;
  let agent: Awaited<ReturnType<typeof seedAgent>>;
  const sessionKey = () => `agent:${agent.id}:direct:${user.id}`;
  const gateBody = (over: object = {}) => ({
    agentId: agent.id,
    sessionKey: sessionKey(),
    toolName: "odoo_write",
    params: { recordId: 5 },
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PINCHY_E2E_GATEWAY_TOKEN = GW;
    user = await seedUser();
    agent = await seedAgent(user.id);
  });

  it("rejects gate-check without the gateway token", async () => {
    const res = await gateCheck(gateReq(gateBody(), null));
    expect(res.status).toBe(401);
  });

  it("allows an ungated tool without creating a pending request", async () => {
    const res = await (await gateCheck(gateReq(gateBody({ toolName: "odoo_list_models" })))).json();
    expect(res.decision).toBe("allow");
    expect(await db.select().from(toolApproval)).toHaveLength(0);
  });

  it("blocks an un-approved gated call: one pending row, one requested-audit, idempotent on retry", async () => {
    const r1 = await (await gateCheck(gateReq(gateBody()))).json();
    expect(r1.decision).toBe("block");
    expect(r1.reason).toContain("Confirmation required");

    const r2 = await (await gateCheck(gateReq(gateBody()))).json();
    expect(r2.requestId).toBe(r1.requestId);

    expect(await db.select().from(toolApproval)).toHaveLength(1);
    const requested = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "approval.requested"));
    expect(requested).toHaveLength(1);
  });

  it("lists the caller's pending confirmations with a redacted summary", async () => {
    await gateCheck(gateReq(gateBody()));
    setSession(user);
    const list = await (
      await listApprovals(new NextRequest("http://localhost/api/approvals"), {})
    ).json();
    expect(list.approvals).toHaveLength(1);
    expect(list.approvals[0].toolName).toBe("odoo_write");
    expect(list.approvals[0].argsSummary).toEqual({ recordId: 5 });
  });

  it("approve → agent retry consumes the ticket + full audit lifecycle", async () => {
    const blocked = await (await gateCheck(gateReq(gateBody()))).json();
    setSession(user);
    const dec = await decide(decideReq({ decision: "approve" }), ctx(blocked.requestId));
    expect(dec.status).toBe(200);

    const allow = await (await gateCheck(gateReq(gateBody()))).json();
    expect(allow.decision).toBe("allow");
    const [row] = await db
      .select()
      .from(toolApproval)
      .where(eq(toolApproval.id, blocked.requestId));
    expect(row.status).toBe("consumed");

    for (const eventType of [
      "approval.requested",
      "approval.granted",
      "approval.consumed",
    ] as const) {
      expect(
        await db.select().from(auditLog).where(eq(auditLog.eventType, eventType)),
        eventType
      ).toHaveLength(1);
    }
  });

  it("forbids a different user from approving (self-confirm)", async () => {
    const blocked = await (await gateCheck(gateReq(gateBody()))).json();
    const other = await seedUser();
    setSession(other);
    const res = await decide(decideReq({ decision: "approve" }), ctx(blocked.requestId));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown request id", async () => {
    setSession(user);
    const res = await decide(
      decideReq({ decision: "approve" }),
      ctx("00000000-0000-4000-8000-000000000000")
    );
    expect(res.status).toBe(404);
  });

  it("deny records the reason and keeps the agent's retry blocked", async () => {
    const blocked = await (await gateCheck(gateReq(gateBody()))).json();
    setSession(user);
    await decide(decideReq({ decision: "deny", reason: "wrong record" }), ctx(blocked.requestId));

    const [row] = await db
      .select()
      .from(toolApproval)
      .where(eq(toolApproval.id, blocked.requestId));
    expect(row.status).toBe("denied");
    expect(row.decisionReason).toBe("wrong record");

    const retry = await (await gateCheck(gateReq(gateBody()))).json();
    expect(retry.decision).toBe("block");
  });
});
