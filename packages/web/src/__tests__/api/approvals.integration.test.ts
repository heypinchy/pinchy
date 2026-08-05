/**
 * Approval routes against a real PostgreSQL — the gate-check security boundary,
 * the requester's pending list, and the self-confirm decision endpoint, with
 * their audit lifecycle. Only the auth boundary (getSession) is mocked; the DB
 * and audit writes are real.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// The decision route schedules its audit write via deferAuditLog -> after(),
// which needs a real request scope. Run the callback synchronously and track
// the promise so tests can `await flushAfter()` before asserting audit rows.
// Mirrors diagnostics-export.integration.test.ts / src/test-setup.ts.
const pendingAfter: Promise<unknown>[] = [];
async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    const all = pendingAfter.splice(0);
    await Promise.allSettled(all);
  }
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      try {
        const result = fn();
        if (result instanceof Promise) {
          pendingAfter.push(result.catch(() => {}));
        }
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

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

  // Drain deferred audit writes before the next test's truncate, so an
  // un-awaited write can't race into another test's table state.
  afterEach(async () => {
    await flushAfter();
  });

  it("rejects gate-check without the gateway token", async () => {
    const res = await gateCheck(gateReq(gateBody(), null));
    expect(res.status).toBe(401);
  });

  it("resolves the lowercased session-key principal back to the real (mixed-case) user id", async () => {
    // OpenClaw normalizes session keys to lowercase, so the gate reads back
    // lower(user.id) — never the mixed-case id Better Auth generates. The stored
    // requesterId must be the REAL casing, or the decision route
    // (session.user.id) and the inbox can never match it (403 / empty inbox).
    const mixedCaseId = "kG5kQuhkQbRpCPm9XHSt3FR1m5KZiHnO";
    await db.insert(users).values({
      id: mixedCaseId,
      name: "Mixed Case",
      email: `mc${emailSeq++}@example.com`,
      emailVerified: true,
      role: "member",
    });
    const [a] = await db
      .insert(agents)
      .values({
        name: "S",
        model: "anthropic/claude-haiku-4-5-20251001",
        greetingMessage: "Hi",
        ownerId: mixedCaseId,
        pluginConfig: { "pinchy-approvals": { confirmTools: ["odoo_write"] } },
      })
      .returning();

    const res = await (
      await gateCheck(
        gateReq({
          agentId: a.id,
          sessionKey: `agent:${a.id}:direct:${mixedCaseId.toLowerCase()}`,
          toolName: "odoo_write",
          params: { recordId: 5 },
        })
      )
    ).json();
    expect(res.decision).toBe("block");

    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, res.requestId));
    expect(row.requesterId).toBe(mixedCaseId);
  });

  it("allows an ungated tool without creating a pending request", async () => {
    const res = await (await gateCheck(gateReq(gateBody({ toolName: "odoo_list_models" })))).json();
    expect(res.decision).toBe("allow");
    expect(await db.select().from(toolApproval)).toHaveLength(0);
  });

  it("blocks an un-approved gated call: one pending row, one requested-audit, idempotent on retry", async () => {
    const r1 = await (await gateCheck(gateReq(gateBody()))).json();
    expect(r1.decision).toBe("block");
    // Wording itself is pinned by the "bogus command" test above; here we only
    // assert that a block carries a reason at all — the model gets nothing to
    // relay without one.
    expect(r1.reason).toMatch(/confirmation/i);

    const r2 = await (await gateCheck(gateReq(gateBody()))).json();
    expect(r2.requestId).toBe(r1.requestId);

    expect(await db.select().from(toolApproval)).toHaveLength(1);
    const requested = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "approval.requested"));
    expect(requested).toHaveLength(1);
  });

  it("blocks with a reason the model cannot turn into a bogus command", async () => {
    // The reason reaches the MODEL as the tool result, and the model relays it
    // to the user. `/approve <id>` is a real OpenClaw command for ITS native
    // approvals — ours live in Pinchy's DB and OpenClaw knows nothing about
    // them. An earlier wording carried the request id, and the model duly
    // invented `/approve 7854bab6-…`, handing the user an instruction that
    // fails. Keep the id out of the prose and out of the model's reach.
    const res = await (await gateCheck(gateReq(gateBody()))).json();
    expect(res.decision).toBe("block");
    expect(res.requestId, "the id still travels in the response body").toBeTruthy();

    expect(res.reason).not.toContain(res.requestId);
    expect(res.reason, "no slash command the user could copy").not.toMatch(/(^|\s)\/\w+/);
    // It must still say what is happening and where to act.
    expect(res.reason).toMatch(/confirm/i);
  });

  it("refuses a gated call it cannot attribute to a Pinchy user", async () => {
    // A channel sender (Telegram id, group principal) is not a Pinchy user, so
    // nobody in that conversation can confirm. Blocking is the only safe answer
    // — and no pending row may be created, because there is no inbox it would
    // ever appear in.
    const res = await (await gateCheck(gateReq(gateBody({ senderId: "telegram:44215" })))).json();
    expect(res.decision).toBe("block");
    expect(res.reason).toMatch(/could not be identified/i);
    expect(await db.select().from(toolApproval)).toHaveLength(0);
  });

  it("refuses a gated call from a run that carries no session key", async () => {
    // The plugin used to answer this one itself, by allowing it: no session key
    // meant "nothing to gate". But the agent and the tool are both known here,
    // so the admin's policy applies in full — what is missing is the person who
    // would confirm. Any run OpenClaw hands over without a session key (cron,
    // subagent) therefore executed every gated tool unchecked. A grant is bound
    // to a session; with none there is nothing to bind and nobody to ask.
    const { sessionKey: _dropped, ...noSession } = gateBody();
    const res = await (await gateCheck(gateReq(noSession))).json();
    expect(res.decision).toBe("block");
    expect(res.reason).toMatch(/could not be identified/i);
    expect(await db.select().from(toolApproval)).toHaveLength(0);
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

  it("does not list expired pending confirmations (no dead cards in the inbox)", async () => {
    await db.insert(toolApproval).values({
      agentId: agent.id,
      requesterId: user.id,
      sessionKey: sessionKey(),
      toolName: "odoo_write",
      argsDigest: "stale-digest",
      tier: "confirm",
      status: "pending",
      expiresAt: new Date(Date.now() - 1000),
    });
    setSession(user);
    const list = await (
      await listApprovals(new NextRequest("http://localhost/api/approvals"), {})
    ).json();
    expect(list.approvals).toHaveLength(0);
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

    await flushAfter();
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
