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
import type { AgentVisibility } from "@/db/enums";

const { getSessionMock, deferAuditLogMock, licenseStateMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  deferAuditLogMock: vi.fn(),
  licenseStateMock: vi.fn(),
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

// Only the license STATE is replaced. The visibility half of the access gate is
// live only on a LICENSED instance — a community instance maps "restricted" to
// "all" (agent-access.effectiveVisibility) — so a suite that inherited the state
// could not tell a visibility denial from a scope denial, and would stay green
// whichever one the route produced. This suite was in exactly that position.
vi.mock("@/lib/enterprise", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enterprise")>()),
  getLicenseState: licenseStateMock,
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
// `visibility` is spelled out by every case whose answer depends on it, rather
// than inherited from the column default — the default IS "restricted", and a
// test whose meaning turns on that is a test that reads as the opposite of what
// it pins.
async function seedAgent(opts: {
  isPersonal: boolean;
  ownerId: string | null;
  visibility?: AgentVisibility;
}) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      isPersonal: opts.isPersonal,
      ownerId: opts.ownerId,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
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
    licenseStateMock.mockResolvedValue("paid");
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

    it("forbids a member from listing the workflows of a shared agent they CAN see", async () => {
      // visibility "all" on purpose: the member can see this agent, so the 403
      // pins the SCOPE rule and nothing else. Left restricted, the very same 403
      // would also be produced by a route that had no scope gate at all — which
      // is the shape this suite was in before the license state was pinned.
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(403);
      // The read-side wording, which the shared gate supplies as its default
      // (#1087) — the create route deliberately overrides it.
      expect(await res.json()).toEqual({ error: "You do not have access to this agent" });
    });

    it("answers 404 for someone else's personal agent — never confirms it exists", async () => {
      // Nobody can enumerate another user's personal agents (getVisibleAgents
      // withholds them from admins too), so a 403 would disclose the one thing
      // the rest of the product refuses to (#880).
      asMember(OTHER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(404);
    });

    it("answers 404 for a restricted shared agent outside the member's groups", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "restricted" });
      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(404);
    });

    it("answers an agent it may not see byte-identically to one that does not exist", async () => {
      asMember(OTHER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });

      const denied = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      const missing = await GET(
        req(`http://localhost/api/automations?agentId=ghost`),
        routeContext()
      );

      // Pinned explicitly, not only compared: two equal statuses prove the
      // oracle closed only once we know WHICH status they agree on.
      expect(denied.status).toBe(404);
      expect(denied.status).toBe(missing.status);
      expect(await denied.json()).toEqual(await missing.json());
    });

    it("answers 404 to an ADMIN for someone else's personal agent", async () => {
      // A deliberate narrowing, not a side effect (#880). `assertAgentAccess`
      // holds personal agents private to their owner *including admins*, while
      // `canManageAgentWorkflows` admits any admin anywhere; the Automations API
      // was where the two met, and it used to resolve them the other way.
      // Running the read gate first settles it the way every other agent-scoped
      // surface already does.
      asAdmin(ADMIN);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const res = await GET(
        req(`http://localhost/api/automations?agentId=${agent.id}`),
        routeContext()
      );
      expect(res.status).toBe(404);
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

    it("answers 404 for a shared agent's workflow — even when the agent is visible", async () => {
      // The verdict for this route differs from the agent-keyed ones, and the
      // visible agent is what makes the difference visible: there, a 403 is
      // honest because the caller has already been told the agent exists. Here
      // the resource is the WORKFLOW, and nobody who fails this scope gate can
      // enumerate workflows at all — GET /api/automations is gated by the very
      // same predicate. So any distinguishable answer discloses that this
      // workflow id is real (#880).
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
      const wf = await seedWorkflow(agent.id, { enabled: false });

      const res = await PATCH(
        req(`http://localhost/api/automations/${wf.id}`, {
          method: "PATCH",
          body: { enabled: true },
        }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(404);
      expect((await loadWorkflow(wf.id)).enabled).toBe(false);
    });

    it("answers a workflow it may not manage exactly as one that does not exist", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
      const wf = await seedWorkflow(agent.id, { enabled: false });

      const denied = await PATCH(
        req(`http://localhost/api/automations/${wf.id}`, {
          method: "PATCH",
          body: { enabled: true },
        }),
        routeContext({ id: wf.id })
      );
      // A real uuid that matches no row — not a malformed id, which the route
      // short-circuits on shape alone and would prove nothing here.
      const ghost = "00000000-0000-4000-8000-000000000000";
      const missing = await PATCH(
        req(`http://localhost/api/automations/${ghost}`, {
          method: "PATCH",
          body: { enabled: true },
        }),
        routeContext({ id: ghost })
      );

      expect(denied.status).toBe(missing.status);
      expect(await denied.json()).toEqual(await missing.json());
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

    it("answers 404 for a shared agent's workflow — even when the agent is visible", async () => {
      asMember(OWNER);
      const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
      const wf = await seedWorkflow(agent.id);

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(404);
      // The refusal is a refusal, not just a quieter status.
      expect(await loadWorkflow(wf.id)).toBeDefined();
      expect(deferAuditLogMock).not.toHaveBeenCalled();
    });

    it("answers 404 for a workflow on someone else's personal agent", async () => {
      asMember(OTHER);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const wf = await seedWorkflow(agent.id);

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(404);
      expect(await loadWorkflow(wf.id)).toBeDefined();
      expect(deferAuditLogMock).not.toHaveBeenCalled();
    });

    it("still lets an admin stop a workflow on someone else's personal agent", async () => {
      // The other half of the #880 narrowing, and the reason it is a narrowing
      // rather than a revocation: the agentId-keyed routes now answer 404 to an
      // admin for a colleague's private agent, but a workflow is standing
      // autonomous authority, and one that misbehaves must stay stoppable by
      // someone. This route is keyed by WORKFLOW id and gates on
      // `canManageAgentWorkflows` alone, so an admin who already holds the id —
      // from the audit trail, which is where they would learn of a runaway
      // workflow — can still delete it.
      //
      // That asymmetry is deliberate: it grants no way to FIND the workflow, so
      // it adds no enumeration, only the ability to act on one already known.
      asAdmin(ADMIN);
      const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
      const wf = await seedWorkflow(agent.id);

      const res = await DELETE(
        req(`http://localhost/api/automations/${wf.id}`, { method: "DELETE" }),
        routeContext({ id: wf.id })
      );
      expect(res.status).toBe(200);
      expect(await loadWorkflow(wf.id)).toBeUndefined();
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
