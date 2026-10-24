// Real-DB tests for the cost-budget API (#36): the upsert runs against the
// UNIQUE NULLS NOT DISTINCT constraint and the CHECKs, which a mocked @/db
// would not exercise. Mocked: the session, the license and the audit writer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, costBudgets, users } from "@/db/schema";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

const { getSessionMock, isEnterpriseMock, appendAuditLogMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  isEnterpriseMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("@/lib/enterprise", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enterprise")>()),
  isEnterprise: isEnterpriseMock,
  getLicenseState: vi.fn().mockResolvedValue("paid"),
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: appendAuditLogMock,
}));

const { GET, PUT } = await import("@/app/api/budgets/route");
const { DELETE } = await import("@/app/api/budgets/[id]/route");

const ADMIN = "budget-admin";
const OTHER_ADMIN = "budget-admin-2";
const MEMBER = "budget-member";

function as(id: string, role: "admin" | "member") {
  getSessionMock.mockResolvedValue({ user: { id, email: `${id}@test.com`, role } });
}

function put(body: unknown) {
  return PUT(
    makeNextRequest("http://localhost/api/budgets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext()
  );
}

async function seedAgent(opts: { isPersonal?: boolean; ownerId?: string | null } = {}) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Knowledge Base",
      model: "anthropic/claude-haiku-5-5",
      greetingMessage: "Hi",
      isPersonal: opts.isPersonal ?? false,
      ownerId: opts.ownerId ?? null,
      visibility: "all",
    })
    .returning();
  return row;
}

async function allBudgets() {
  return db.select().from(costBudgets);
}

beforeEach(async () => {
  vi.clearAllMocks();
  isEnterpriseMock.mockResolvedValue(true);
  await db.insert(users).values([
    { id: ADMIN, name: "Admin", email: `${ADMIN}@test.com`, role: "admin" },
    { id: OTHER_ADMIN, name: "Other", email: `${OTHER_ADMIN}@test.com`, role: "admin" },
    { id: MEMBER, name: "Member", email: `${MEMBER}@test.com`, role: "member" },
  ]);
});

describe("PUT /api/budgets", () => {
  it("creates the instance budget and audits it", async () => {
    as(ADMIN, "admin");

    const res = await put({ agentId: null, monthlyLimitUsd: 120, onExceeded: "notify" });

    expect(res.status).toBe(200);
    const [row] = await allBudgets();
    expect(row).toMatchObject({ agentId: null, monthlyLimitUsd: "120.00", onExceeded: "notify" });
    expect(appendAuditLogMock).toHaveBeenCalledWith({
      actorType: "user",
      actorId: ADMIN,
      eventType: "budget.created",
      resource: `budget:${row.id}`,
      outcome: "success",
      detail: {
        budget: { id: row.id, scope: "instance" },
        monthlyLimitUsd: 120,
        onExceeded: "notify",
      },
    });
  });

  it("updates the same row on a second save and audits what changed", async () => {
    as(ADMIN, "admin");
    const agent = await seedAgent();
    await put({ agentId: agent.id, monthlyLimitUsd: 50, onExceeded: "notify" });
    appendAuditLogMock.mockClear();

    const res = await put({ agentId: agent.id, monthlyLimitUsd: 80, onExceeded: "block" });

    expect(res.status).toBe(200);
    const rows = await allBudgets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ monthlyLimitUsd: "80.00", onExceeded: "block" });
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "budget.updated",
        detail: {
          budget: {
            id: rows[0].id,
            scope: "agent",
            agent: { id: agent.id, name: "Knowledge Base" },
          },
          changes: {
            monthlyLimitUsd: { from: 50, to: 80 },
            onExceeded: { from: "notify", to: "block" },
          },
        },
      })
    );
  });

  it("re-arms this month's alerts when the limit changes — the new line deserves its own warning", async () => {
    as(ADMIN, "admin");
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });
    await db.update(costBudgets).set({ warnedPeriod: "2026-10", exceededPeriod: "2026-10" });

    await put({ agentId: null, monthlyLimitUsd: 90, onExceeded: "notify" });

    const [row] = await allBudgets();
    expect(row.warnedPeriod).toBeNull();
    expect(row.exceededPeriod).toBeNull();
  });

  it("keeps this month's alerts when only the action changes — the line did not move", async () => {
    as(ADMIN, "admin");
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });
    await db.update(costBudgets).set({ warnedPeriod: "2026-10", exceededPeriod: "2026-10" });

    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "block" });

    const [row] = await allBudgets();
    expect(row.onExceeded).toBe("block");
    expect(row.warnedPeriod).toBe("2026-10");
    expect(row.exceededPeriod).toBe("2026-10");
  });

  it("answers two simultaneous saves for the same scope with one budget, not a 500", async () => {
    as(ADMIN, "admin");

    const [a, b] = await Promise.all([
      put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" }),
      put({ agentId: null, monthlyLimitUsd: 60, onExceeded: "notify" }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await allBudgets()).toHaveLength(1);
  });

  it("writes no audit row for a save that changed nothing", async () => {
    as(ADMIN, "admin");
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });
    appendAuditLogMock.mockClear();

    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });

    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("is an Enterprise feature", async () => {
    as(ADMIN, "admin");
    isEnterpriseMock.mockResolvedValue(false);

    const res = await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });

    expect(res.status).toBe(403);
    expect(await allBudgets()).toHaveLength(0);
  });

  it("is admin-only", async () => {
    as(MEMBER, "member");
    const res = await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });
    expect(res.status).toBe(403);
  });

  it("rejects a limit that is not a positive amount of money", async () => {
    as(ADMIN, "admin");
    expect((await put({ agentId: null, monthlyLimitUsd: 0, onExceeded: "notify" })).status).toBe(
      400
    );
    expect((await put({ agentId: null, monthlyLimitUsd: 10, onExceeded: "pause" })).status).toBe(
      400
    );
  });

  it("answers 404 for an agent the admin cannot see — a colleague's personal agent", async () => {
    as(ADMIN, "admin");
    const smithers = await seedAgent({ isPersonal: true, ownerId: MEMBER });

    const res = await put({ agentId: smithers.id, monthlyLimitUsd: 10, onExceeded: "block" });

    expect(res.status).toBe(404);
    expect(await allBudgets()).toHaveLength(0);
  });
});

describe("GET /api/budgets", () => {
  it("lists every budget with this month's spend for an admin", async () => {
    as(ADMIN, "admin");
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "block" });

    const res = await GET(makeNextRequest("http://localhost/api/budgets"), routeContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { agent: null, monthlyLimitUsd: 50, onExceeded: "block", spentUsd: 0, state: "ok" },
    ]);
  });

  it("leaves out a budget on another admin's personal agent — the PUT gate's rule, on the read side", async () => {
    as(OTHER_ADMIN, "admin");
    const theirs = await seedAgent({ isPersonal: true, ownerId: OTHER_ADMIN });
    await put({ agentId: theirs.id, monthlyLimitUsd: 10, onExceeded: "notify" });
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "notify" });

    as(ADMIN, "admin");
    const forAdmin = await (
      await GET(makeNextRequest("http://localhost/api/budgets"), routeContext())
    ).json();
    as(OTHER_ADMIN, "admin");
    const forOwner = await (
      await GET(makeNextRequest("http://localhost/api/budgets"), routeContext())
    ).json();

    expect(forAdmin.map((b: { agent: unknown }) => b.agent)).toEqual([null]);
    expect(forOwner).toHaveLength(2);
  });

  it("answers a member 403", async () => {
    as(MEMBER, "member");
    const res = await GET(makeNextRequest("http://localhost/api/budgets"), routeContext());
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/budgets/[id]", () => {
  it("deletes a budget and snapshots it by name in the audit row", async () => {
    as(ADMIN, "admin");
    const agent = await seedAgent();
    await put({ agentId: agent.id, monthlyLimitUsd: 50, onExceeded: "block" });
    const [row] = await allBudgets();
    appendAuditLogMock.mockClear();

    const res = await DELETE(
      makeNextRequest(`http://localhost/api/budgets/${row.id}`, { method: "DELETE" }),
      routeContext({ id: row.id })
    );

    expect(res.status).toBe(200);
    expect(await db.select().from(costBudgets).where(eq(costBudgets.id, row.id))).toHaveLength(0);
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "budget.deleted",
        resource: `budget:${row.id}`,
        detail: expect.objectContaining({
          name: "Knowledge Base",
          monthlyLimitUsd: 50,
          onExceeded: "block",
        }),
      })
    );
  });

  it("stays possible without a license, so a lapsed one can never strand a blocked instance", async () => {
    as(ADMIN, "admin");
    await put({ agentId: null, monthlyLimitUsd: 50, onExceeded: "block" });
    const [row] = await allBudgets();
    isEnterpriseMock.mockResolvedValue(false);

    const res = await DELETE(
      makeNextRequest(`http://localhost/api/budgets/${row.id}`, { method: "DELETE" }),
      routeContext({ id: row.id })
    );

    expect(res.status).toBe(200);
    expect(await allBudgets()).toHaveLength(0);
  });

  it("answers 404 for a budget on another admin's personal agent, and leaves it alone", async () => {
    as(OTHER_ADMIN, "admin");
    const theirs = await seedAgent({ isPersonal: true, ownerId: OTHER_ADMIN });
    const { id } = await (
      await put({ agentId: theirs.id, monthlyLimitUsd: 10, onExceeded: "notify" })
    ).json();

    as(ADMIN, "admin");
    const res = await DELETE(
      makeNextRequest(`http://localhost/api/budgets/${id}`, { method: "DELETE" }),
      routeContext({ id })
    );

    expect(res.status).toBe(404);
    expect(await allBudgets()).toHaveLength(1);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    as(ADMIN, "admin");
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await DELETE(
        makeNextRequest(`http://localhost/api/budgets/${id}`, { method: "DELETE" }),
        routeContext({ id })
      );
      expect(res.status).toBe(404);
    }
  });
});
