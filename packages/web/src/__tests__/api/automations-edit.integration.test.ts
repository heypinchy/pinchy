// Real-DB integration tests for PUT /api/automations/[id] — the edit-in-place
// path that closes the last gap in the Automations lifecycle: create → review →
// enable/disable → **edit** → delete. Until this, changing a workflow's fields
// meant delete + recreate, which always re-births it pending+disabled and (worse)
// resets every connection watermark, so an enabled reconciler silently either
// re-processed or skipped mail. PUT edits in place.
//
// Real DB (not mocked chains) for the same reasons the create/manage routes are:
// the load-bearing behavior is scope-based RBAC over agent ownership, the SAME
// email-read connection gate the create route enforces, and — the subtle one —
// connection reconciliation that must PRESERVE the watermark of a kept mailbox
// while stamping a newly-added one at `now`. Only a real query proves those.
// @/lib/auth and @/lib/audit-deferred are mocked to drive the scope branches and
// capture audit payloads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  users,
  emailWorkflows,
  emailWorkflowConnections,
  integrationConnections,
  agentConnectionPermissions,
} from "@/db/schema";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

const { getSessionMock, deferAuditLogMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  deferAuditLogMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => deferAuditLogMock(...args),
}));

const { PUT } = await import("@/app/api/automations/[id]/route");

const OWNER = "user-owner";
const ADMIN = "user-admin";

function asMember(id: string) {
  getSessionMock.mockResolvedValue({ user: { id, email: `${id}@test.com`, role: "member" } });
}
function asAdmin(id: string) {
  getSessionMock.mockResolvedValue({ user: { id, email: `${id}@test.com`, role: "admin" } });
}

async function seedUser(id: string, role: "member" | "admin" = "member") {
  await db.insert(users).values({ id, name: id, email: `${id}@test.com`, role });
}
async function seedAgent(opts: { isPersonal: boolean; ownerId: string | null }) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      isPersonal: opts.isPersonal,
      ownerId: opts.ownerId,
    })
    .returning();
  return row;
}
async function seedConnection(id: string, name = "Mailbox") {
  await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name, credentials: "enc:placeholder" });
}
async function grantEmailRead(agentId: string, connectionId: string) {
  await db
    .insert(agentConnectionPermissions)
    .values({ agentId, connectionId, model: "email", operation: "read" });
}
async function seedWorkflow(
  agentId: string,
  opts: {
    enabled?: boolean;
    name?: string;
    filter?: unknown;
    action?: string;
    sweepWindowDays?: number;
    createdBy?: string;
  } = {}
) {
  const [wf] = await db
    .insert(emailWorkflows)
    .values({
      agentId,
      name: opts.name ?? "File supplier invoices",
      filter: opts.filter ?? { hasAttachment: true },
      action: opts.action ?? "Draft a supplier bill.",
      sweepWindowDays: opts.sweepWindowDays ?? 14,
      enabled: opts.enabled ?? false,
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  return wf;
}
async function linkConnection(workflowId: string, connectionId: string, sinceTs: Date) {
  await db.insert(emailWorkflowConnections).values({ workflowId, connectionId, sinceTs });
}

function put(id: string, body: unknown) {
  return makeNextRequest(`http://localhost/api/automations/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadWorkflow(id: string) {
  const [row] = await db.select().from(emailWorkflows).where(eq(emailWorkflows.id, id));
  return row;
}
async function loadConnections(workflowId: string) {
  return db
    .select()
    .from(emailWorkflowConnections)
    .where(eq(emailWorkflowConnections.workflowId, workflowId));
}

/** A full, valid edit payload — override per test. */
function editBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "File supplier invoices",
    filter: { hasAttachment: true },
    action: "Draft a supplier bill.",
    connectionIds: ["conn-a"],
    sweepWindowDays: 14,
    ...overrides,
  };
}

describe("PUT /api/automations/[id]", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedUser(OWNER);
    await seedUser(ADMIN, "admin");
  });

  it("updates name, filter, action and sweep window on an owner's personal-agent workflow", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-a");
    await grantEmailRead(agent.id, "conn-a");
    const wf = await seedWorkflow(agent.id, { createdBy: OWNER });
    await linkConnection(wf.id, "conn-a", new Date("2020-01-01T00:00:00Z"));

    const res = await PUT(
      put(
        wf.id,
        editBody({
          name: "File and pay invoices",
          filter: { from: ["ap@acme.com"], subjectContains: ["invoice"] },
          action: "Draft AND schedule payment for the supplier bill.",
          sweepWindowDays: 30,
        })
      ),
      routeContext({ id: wf.id })
    );
    expect(res.status).toBe(200);

    const row = await loadWorkflow(wf.id);
    expect(row.name).toBe("File and pay invoices");
    expect(row.filter).toEqual({ from: ["ap@acme.com"], subjectContains: ["invoice"] });
    expect(row.action).toBe("Draft AND schedule payment for the supplier bill.");
    expect(row.sweepWindowDays).toBe(30);
    // Edit never flips activation — enabled/status stay under the toggle's sole
    // control (propose, don't self-activate; the editor is the same authority as
    // the enabler, but activation stays an explicit, separate human act).
    expect(row.enabled).toBe(false);
    expect(row.status).toBe("pending");

    expect(deferAuditLogMock).toHaveBeenCalledTimes(1);
    const entry = deferAuditLogMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      eventType: "email_workflow.updated",
      actorType: "user",
      actorId: OWNER,
      resource: `email_workflow:${wf.id}`,
      outcome: "success",
    });
    // changedFields is the complete, PII-safe list of what moved; changes carries
    // before/after only for the safe fields (name scrubbed, sweep window).
    // action/filter are named but never dumped (they can carry addresses).
    expect([...entry.detail.changedFields].sort()).toEqual([
      "action",
      "filter",
      "name",
      "sweepWindowDays",
    ]);
    expect(entry.detail.changes).toEqual({
      name: { from: "File supplier invoices", to: "File and pay invoices" },
      sweepWindowDays: { from: 14, to: 30 },
    });
    // Connections untouched → no connections diff.
    expect(entry.detail.connections).toBeUndefined();
  });

  it("reconciles connections: preserves a kept mailbox's watermark, stamps a new one at now, drops the removed", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-keep");
    await seedConnection("conn-drop");
    await seedConnection("conn-add");
    await grantEmailRead(agent.id, "conn-keep");
    await grantEmailRead(agent.id, "conn-drop");
    await grantEmailRead(agent.id, "conn-add");
    const wf = await seedWorkflow(agent.id, { createdBy: OWNER });
    const keptWatermark = new Date("2020-06-15T12:00:00Z");
    await linkConnection(wf.id, "conn-keep", keptWatermark);
    await linkConnection(wf.id, "conn-drop", new Date("2020-06-15T12:00:00Z"));

    const before = Date.now();
    const res = await PUT(
      put(wf.id, editBody({ connectionIds: ["conn-keep", "conn-add"] })),
      routeContext({ id: wf.id })
    );
    expect(res.status).toBe(200);

    const conns = await loadConnections(wf.id);
    const byId = new Map(conns.map((c) => [c.connectionId, c]));
    expect([...byId.keys()].sort()).toEqual(["conn-add", "conn-keep"]);
    // Kept mailbox: its watermark is UNTOUCHED — resetting it would make an
    // enabled reconciler re-list (or skip) mail across the gap.
    expect(byId.get("conn-keep")!.sinceTs.getTime()).toBe(keptWatermark.getTime());
    // Newly added mailbox: stamped at ~now, so it never retroactively sweeps
    // history (design §8, same rule as create).
    expect(byId.get("conn-add")!.sinceTs.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Removed mailbox: gone.
    expect(byId.has("conn-drop")).toBe(false);

    const entry = deferAuditLogMock.mock.calls[0][0];
    expect(entry.detail.changedFields).toContain("connections");
    expect(entry.detail.connections).toEqual({ added: ["conn-add"], removed: ["conn-drop"] });
  });

  it("rejects a connection the agent may not read — the same gate the create route enforces", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-a");
    await grantEmailRead(agent.id, "conn-a");
    await seedConnection("conn-forbidden");
    // conn-forbidden exists but the agent has no email-read grant on it.
    const wf = await seedWorkflow(agent.id, { createdBy: OWNER });
    await linkConnection(wf.id, "conn-a", new Date("2020-01-01T00:00:00Z"));

    const res = await PUT(
      put(wf.id, editBody({ connectionIds: ["conn-a", "conn-forbidden"] })),
      routeContext({ id: wf.id })
    );
    expect(res.status).toBe(400);
    // Nothing was written — the workflow still points only at conn-a.
    const conns = await loadConnections(wf.id);
    expect(conns.map((c) => c.connectionId)).toEqual(["conn-a"]);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("forbids a member from editing a shared agent's workflow", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: false, ownerId: null });
    await seedConnection("conn-a");
    await grantEmailRead(agent.id, "conn-a");
    const wf = await seedWorkflow(agent.id, { name: "Untouched" });
    await linkConnection(wf.id, "conn-a", new Date("2020-01-01T00:00:00Z"));

    const res = await PUT(put(wf.id, editBody({ name: "Hijacked" })), routeContext({ id: wf.id }));
    expect(res.status).toBe(403);
    expect((await loadWorkflow(wf.id)).name).toBe("Untouched");
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("lets an admin edit a shared agent's workflow", async () => {
    asAdmin(ADMIN);
    const agent = await seedAgent({ isPersonal: false, ownerId: null });
    await seedConnection("conn-a");
    await grantEmailRead(agent.id, "conn-a");
    const wf = await seedWorkflow(agent.id, { name: "Before" });
    await linkConnection(wf.id, "conn-a", new Date("2020-01-01T00:00:00Z"));

    const res = await PUT(put(wf.id, editBody({ name: "After" })), routeContext({ id: wf.id }));
    expect(res.status).toBe(200);
    expect((await loadWorkflow(wf.id)).name).toBe("After");
  });

  it("returns 404 for an unknown workflow", async () => {
    asMember(OWNER);
    const res = await PUT(
      put("11111111-1111-4111-8111-111111111111", editBody()),
      routeContext({ id: "11111111-1111-4111-8111-111111111111" })
    );
    expect(res.status).toBe(404);
  });

  it("does not audit a no-op edit (identical fields and connections)", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-a");
    await grantEmailRead(agent.id, "conn-a");
    const wf = await seedWorkflow(agent.id, {
      name: "Steady",
      filter: { hasAttachment: true },
      action: "Draft a supplier bill.",
      sweepWindowDays: 14,
      createdBy: OWNER,
    });
    await linkConnection(wf.id, "conn-a", new Date("2020-01-01T00:00:00Z"));

    const res = await PUT(
      put(
        wf.id,
        editBody({
          name: "Steady",
          filter: { hasAttachment: true },
          action: "Draft a supplier bill.",
          connectionIds: ["conn-a"],
          sweepWindowDays: 14,
        })
      ),
      routeContext({ id: wf.id })
    );
    expect(res.status).toBe(200);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
    // The kept connection's watermark is left alone on a no-op too.
    const conns = await loadConnections(wf.id);
    expect(conns[0].sinceTs.getTime()).toBe(new Date("2020-01-01T00:00:00Z").getTime());
  });
});
