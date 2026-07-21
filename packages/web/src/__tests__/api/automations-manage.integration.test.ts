// Real-DB integration tests for the Automations management API — the read +
// enable/disable + delete surface that completes the create → review → enable
// loop the write path (#864) opened. A created workflow lands pending+disabled;
// the sweep dispatches only ENABLED workflows, so without an enable path nothing
// a user creates ever runs. These routes are that path.
//
// Real DB (not mocked chains) for the same reason as the create route: the
// load-bearing behavior is scope-based RBAC that queries agent ownership, plus
// a cascading delete. @/lib/auth and @/lib/audit-deferred are mocked to drive
// the scope branches and capture audit payloads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  users,
  emailWorkflows,
  emailWorkflowConnections,
  integrationConnections,
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

const { GET } = await import("@/app/api/automations/route");
const { PATCH, DELETE } = await import("@/app/api/automations/[id]/route");

const OWNER = "user-owner";
const OTHER = "user-other";
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
async function seedConnection(id: string) {
  await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name: "Invoices mailbox", credentials: "enc:placeholder" });
}
async function seedWorkflow(
  agentId: string,
  opts: { enabled?: boolean; name?: string; createdBy?: string } = {}
) {
  const [wf] = await db
    .insert(emailWorkflows)
    .values({
      agentId,
      name: opts.name ?? "File supplier invoices",
      filter: { hasAttachment: true },
      action: "Draft a supplier bill.",
      enabled: opts.enabled ?? false,
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  return wf;
}
async function linkConnection(workflowId: string, connectionId: string) {
  await db
    .insert(emailWorkflowConnections)
    .values({ workflowId, connectionId, sinceTs: new Date() });
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return makeNextRequest(url, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

async function loadWorkflow(id: string) {
  const [row] = await db.select().from(emailWorkflows).where(eq(emailWorkflows.id, id));
  return row;
}

describe("Automations management API", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedUser(OWNER);
    await seedUser(OTHER);
    await seedUser(ADMIN, "admin");
  });

  describe("GET /api/automations?agentId", () => {
    it("lists a member's own personal-agent workflows with their connections", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      await seedConnection("conn-a");
      const wf = await seedWorkflow(agent.id, { createdBy: OWNER });
      await linkConnection(wf.id, "conn-a");

      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: wf.id,
        name: "File supplier invoices",
        enabled: false,
        status: "pending",
        connectionIds: ["conn-a"],
      });
    });

    it("forbids a member from listing a shared agent's workflows", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null });
      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(403);
    });

    it("requires an agentId query parameter", async () => {
      asMember(OWNER);
      const res = await GET(req(`http://localhost/api/automations`), routeContext());
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown agent", async () => {
      asMember(OWNER);
      const res = await GET(req(`http://localhost/api/automations?agentId=ghost`), routeContext());
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/automations/[id]", () => {
    it("lets a member enable a pending workflow on their own personal agent", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const wf = await seedWorkflow(agent.id, { enabled: false, createdBy: OWNER });

      const res = await PATCH(
        req(`http://localhost/api/automations/${wf.id}`, {
          method: "PATCH",
          body: { enabled: true },
        }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(200);
      expect((await loadWorkflow(wf.id)).enabled).toBe(true);

      expect(deferAuditLogMock).toHaveBeenCalledTimes(1);
      const entry = deferAuditLogMock.mock.calls[0][0];
      expect(entry).toMatchObject({
        eventType: "email_workflow.updated",
        actorType: "user",
        actorId: OWNER,
        resource: `email_workflow:${wf.id}`,
        outcome: "success",
      });
      expect(entry.detail.changes).toMatchObject({ enabled: { from: false, to: true } });
    });

    it("does not audit a no-op toggle", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const wf = await seedWorkflow(agent.id, { enabled: false, createdBy: OWNER });

      const res = await PATCH(
        req(`http://localhost/api/automations/${wf.id}`, {
          method: "PATCH",
          body: { enabled: false },
        }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(200);
      expect(deferAuditLogMock).not.toHaveBeenCalled();
    });

    it("forbids a member from toggling a shared agent's workflow", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null });
      const wf = await seedWorkflow(agent.id, { enabled: false });

      const res = await PATCH(
        req(`http://localhost/api/automations/${wf.id}`, {
          method: "PATCH",
          body: { enabled: true },
        }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(403);
      expect((await loadWorkflow(wf.id)).enabled).toBe(false);
    });

    it("returns 404 for an unknown workflow", async () => {
      asMember(OWNER);
      const res = await PATCH(
        req(`http://localhost/api/automations/ghost`, { method: "PATCH", body: { enabled: true } }),
        routeContext({ id: "ghost" })
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/automations/[id]", () => {
    it("lets a member delete their own personal-agent workflow and cascades its connections", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      await seedConnection("conn-d");
      const wf = await seedWorkflow(agent.id, { name: "Reject me", createdBy: OWNER });
      await linkConnection(wf.id, "conn-d");

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(200);
      expect(await loadWorkflow(wf.id)).toBeUndefined();
      const conns = await db
        .select()
        .from(emailWorkflowConnections)
        .where(eq(emailWorkflowConnections.workflowId, wf.id));
      expect(conns).toHaveLength(0);

      expect(deferAuditLogMock).toHaveBeenCalledTimes(1);
      const entry = deferAuditLogMock.mock.calls[0][0];
      expect(entry).toMatchObject({
        eventType: "email_workflow.deleted",
        actorId: OWNER,
        resource: `email_workflow:${wf.id}`,
        outcome: "success",
      });
      // DeleteDetail requires a name snapshot — the row is gone, so the trail
      // must carry it (AGENTS.md: include resource names in delete events).
      expect(entry.detail.name).toBe("Reject me");
    });

    it("forbids a member from deleting a shared agent's workflow", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null });
      const wf = await seedWorkflow(agent.id);

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(403);
      expect(await loadWorkflow(wf.id)).toBeDefined();
    });

    it("lets an admin delete a shared agent's workflow", async () => {
      asAdmin(ADMIN);
      const agent = await seedAgent({ isPersonal: false, ownerId: null });
      const wf = await seedWorkflow(agent.id);

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(200);
      expect(await loadWorkflow(wf.id)).toBeUndefined();
    });

    it("returns 404 for an unknown workflow", async () => {
      asMember(OWNER);
      const res = await DELETE(
        req(`http://localhost/api/automations/ghost`, { method: "DELETE" }),
        routeContext({ id: "ghost" })
      );
      expect(res.status).toBe(404);
    });
  });
});
