// Real-DB integration tests for POST /api/automations — the single write path
// for the Inbox Agent's email workflows (design §5; the foundation both the
// Automations form #139 and the conversational create tool #705 write through).
//
// Why real DB, not mocked chains: the load-bearing behavior here is a
// transactional two-table write (email_workflows + email_workflow_connections)
// with a per-connection watermark, plus scope-based RBAC that queries the
// agent's ownership and its connection permissions. Mocking @/db would assert
// nothing about any of that. So @/db runs for real against a freshly migrated
// Postgres (global-setup.ts), truncated between cases (setup.ts).
//
// What stays mocked, and why:
//   - @/lib/auth.getSession — the only way to drive the withAuth scope branches
//     (member vs admin, owner vs not) deterministically.
//   - @/lib/audit-deferred.deferAuditLog — a thin next/after wrapper whose
//     callback does not run under a direct handler call; we assert the payload
//     it was handed instead of round-tripping through `after()`.
//   - @/lib/enterprise.getLicenseState — the visibility half of the access gate
//     is only LIVE on a licensed instance: a community instance maps
//     "restricted" to "all" (agent-access.effectiveVisibility), so a suite that
//     left this unmocked could not tell a visibility denial from a scope denial
//     and would stay green whichever one the route produced. "paid" is the state
//     a paying customer runs in, and the one where these answers matter.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  users,
  emailWorkflows,
  emailWorkflowConnections,
  agentConnectionPermissions,
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

// Only the license STATE is replaced; the rest of the module stays real so
// nothing else in the route's graph silently loses behavior.
vi.mock("@/lib/enterprise", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enterprise")>()),
  getLicenseState: licenseStateMock,
}));

// Imported after the mocks are registered.
const { POST } = await import("@/app/api/automations/route");

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
  const [row] = await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name: "Invoices mailbox", credentials: "enc:placeholder" })
    .returning();
  return row;
}

async function grantEmailPermission(agentId: string, connectionId: string, operation = "read") {
  await db
    .insert(agentConnectionPermissions)
    .values({ agentId, connectionId, model: "email", operation });
}

function postBody(body: Record<string, unknown>) {
  return makeNextRequest("http://localhost/api/automations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = (agentId: string, connectionId: string) => ({
  agentId,
  name: "File supplier invoices",
  filter: { hasAttachment: true, attachmentType: "application/pdf" },
  action: "Draft a supplier bill in Odoo from the attached invoice.",
  connectionIds: [connectionId],
  sweepWindowDays: 30,
});

async function loadWorkflows(agentId: string) {
  return db.select().from(emailWorkflows).where(eq(emailWorkflows.agentId, agentId));
}

describe("POST /api/automations — create email workflow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    licenseStateMock.mockResolvedValue("paid");
    // agents.owner_id and email_workflows.created_by both FK to user.id, so the
    // actors must exist before any agent/workflow references them.
    await seedUser(OWNER);
    await seedUser(OTHER);
    await seedUser(ADMIN, "admin");
  });

  it("lets a member create a workflow on their own personal agent + a permitted connection", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-own");
    await grantEmailPermission(agent.id, "conn-own");

    const before = Date.now();
    const res = await POST(postBody(validBody(agent.id, "conn-own")), routeContext());
    expect(res.status).toBe(201);

    // Propose, don't self-activate: the workflow lands pending + disabled, its
    // creator recorded, never active — activation is a separate human step.
    const [wf] = await loadWorkflows(agent.id);
    expect(wf).toBeDefined();
    expect(wf.enabled).toBe(false);
    expect(wf.status).toBe("pending");
    expect(wf.createdBy).toBe(OWNER);
    expect(wf.name).toBe("File supplier invoices");
    expect(wf.sweepWindowDays).toBe(30);
    expect(wf.filter).toEqual({ hasAttachment: true, attachmentType: "application/pdf" });

    // The connection is attached with a NOW watermark, so the new workflow
    // never retroactively processes historical mail (design §8).
    const conns = await db
      .select()
      .from(emailWorkflowConnections)
      .where(eq(emailWorkflowConnections.workflowId, wf.id));
    expect(conns).toHaveLength(1);
    expect(conns[0].connectionId).toBe("conn-own");
    expect(conns[0].sinceTs.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(conns[0].sinceTs.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Audited: email_workflow.created with the resource pointer, {id, name}
    // snapshots (name scrubbed — see the PII test below), connections as ids
    // only (their names can carry addresses).
    expect(deferAuditLogMock).toHaveBeenCalledTimes(1);
    const entry = deferAuditLogMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      eventType: "email_workflow.created",
      actorType: "user",
      actorId: OWNER,
      resource: `email_workflow:${wf.id}`,
      outcome: "success",
    });
    expect(entry.detail).toMatchObject({
      workflow: { id: wf.id, name: "File supplier invoices" },
      agent: { id: agent.id, name: "Smithers" },
      connectionCount: 1,
      enabled: false,
      status: "pending",
    });
  });

  it("forbids a member from creating a workflow on a shared agent they CAN see (admin-only scope)", async () => {
    // visibility "all" on purpose: the member can see this agent, so the 403
    // pins the SCOPE rule and nothing else. Left restricted, the very same 403
    // would also be produced by a route that had no scope gate at all.
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
    await seedConnection("conn-shared");
    await grantEmailPermission(agent.id, "conn-shared");

    const res = await POST(postBody(validBody(agent.id, "conn-shared")), routeContext());
    expect(res.status).toBe(403);
    // The wording, not just the status: create shares its scope gate with the
    // two GET routes but keeps its own refusal ("permission to create a
    // workflow", not "access to this agent"). Since #1087 that is a defaulted
    // parameter, so an omitted argument would silently swap the sentence.
    expect(await res.json()).toEqual({
      error: "You do not have permission to create a workflow on this agent",
    });
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("answers 404 for someone else's personal agent — never confirms it exists", async () => {
    // Nobody can enumerate another user's personal agents — getVisibleAgents
    // withholds them from every caller, admins included — so a 403 here would
    // disclose the one thing the rest of the product refuses to: that this id is
    // a real agent.
    asMember(OTHER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-x");
    await grantEmailPermission(agent.id, "conn-x");

    const res = await POST(postBody(validBody(agent.id, "conn-x")), routeContext());
    expect(res.status).toBe(404);
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a restricted shared agent outside the member's groups", async () => {
    // The other half of "cannot see". Only live on a LICENSED instance: a
    // community instance maps "restricted" to "all", which is why this suite
    // pins the license state rather than inheriting it.
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "restricted" });
    await seedConnection("conn-restricted");
    await grantEmailPermission(agent.id, "conn-restricted");

    const res = await POST(postBody(validBody(agent.id, "conn-restricted")), routeContext());
    expect(res.status).toBe(404);
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("answers 404 to an ADMIN for someone else's personal agent", async () => {
    // The admin-visible consequence of running the read gate first, and it is a
    // deliberate narrowing rather than a side effect (#880): `assertAgentAccess`
    // holds personal agents private to their owner *including admins* — its own
    // comment says the admin fast-path must not bypass it — while
    // `canManageAgentWorkflows` returns true for any admin on any agent. The
    // Automations API was the one place those two rules met, and it used to
    // resolve them the other way, granting admins a reach into a colleague's
    // private agent that no other agent-scoped surface gives them.
    //
    // The emergency capability survives one route down: an admin holding a
    // WORKFLOW id can still stop it (automations-manage.integration.test.ts).
    asAdmin(ADMIN);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-admin-personal");
    await grantEmailPermission(agent.id, "conn-admin-personal");

    const res = await POST(postBody(validBody(agent.id, "conn-admin-personal")), routeContext());
    expect(res.status).toBe(404);
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("answers an agent it may not see byte-identically to one that does not exist", async () => {
    // The oracle is closed by the two answers being the SAME, not by both merely
    // being 404 — a divergent body re-opens what an equal status closed.
    asMember(OTHER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });

    const denied = await POST(postBody(validBody(agent.id, "conn-any")), routeContext());
    const missing = await POST(postBody(validBody("no-such-agent", "conn-any")), routeContext());

    // Pinned explicitly, not just compared: "conn-any" is deliberately unseeded,
    // so a route that checked connections BEFORE the agent would answer 400 to
    // both and satisfy the comparison while asserting nothing about the oracle.
    // Symmetric blindness reads exactly like agreement.
    expect(denied.status).toBe(404);
    expect(denied.status).toBe(missing.status);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it("lets an admin create a workflow on a shared agent", async () => {
    asAdmin(ADMIN);
    const agent = await seedAgent({ isPersonal: false, ownerId: null });
    await seedConnection("conn-shared2");
    await grantEmailPermission(agent.id, "conn-shared2");

    const res = await POST(postBody(validBody(agent.id, "conn-shared2")), routeContext());
    expect(res.status).toBe(201);
    const [wf] = await loadWorkflows(agent.id);
    expect(wf.status).toBe("pending");
    expect(wf.createdBy).toBe(ADMIN);
  });

  it("rejects a connection whose only email permission is send — a workflow must READ mail", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-send-only");
    await grantEmailPermission(agent.id, "conn-send-only", "send");

    const res = await POST(postBody(validBody(agent.id, "conn-send-only")), routeContext());
    expect(res.status).toBe(400);
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("accepts a legacy 'search' permission row as a read grant", async () => {
    // Pre-#328 template creation could write raw per-tool operations ("search",
    // "list") without an accompanying "read" row; the runtime treats them as
    // read aliases (tool-registry.getEmailToolsForOperations), so the gate
    // here must too — otherwise a legacy agent can't get a workflow at all.
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-legacy");
    await grantEmailPermission(agent.id, "conn-legacy", "search");

    const res = await POST(postBody(validBody(agent.id, "conn-legacy")), routeContext());
    expect(res.status).toBe(201);
    expect(await loadWorkflows(agent.id)).toHaveLength(1);
  });

  it("scrubs email addresses from the workflow name before it lands in the audit detail", async () => {
    // The name is free user text and the audit log is append-only + HMAC-signed
    // (GDPR Art. 17: no erasure once written), so an address in the name must
    // never reach `detail` — same treatment as the IMAP route's connectionName.
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-pii");
    await grantEmailPermission(agent.id, "conn-pii");

    const res = await POST(
      postBody({
        ...validBody(agent.id, "conn-pii"),
        name: "Forward mail from boss@acme.com",
      }),
      routeContext()
    );
    expect(res.status).toBe(201);

    // The stored workflow and the API response keep the raw name — only the
    // un-erasable audit detail is scrubbed.
    const [wf] = await loadWorkflows(agent.id);
    expect(wf.name).toBe("Forward mail from boss@acme.com");
    expect(await res.json()).toMatchObject({ name: "Forward mail from boss@acme.com" });

    const entry = deferAuditLogMock.mock.calls[0][0];
    expect(entry.detail.workflow).toEqual({
      id: wf.id,
      name: "Forward mail from <email-redacted>",
    });
  });

  it("rejects a connection the agent has no email permission for — no partial write", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-unpermitted"); // exists, but no permission granted

    const res = await POST(postBody(validBody(agent.id, "conn-unpermitted")), routeContext());
    expect(res.status).toBe(400);
    // The two-table write is transactional: a bad connection writes NOTHING.
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
    expect(deferAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown agent", async () => {
    asMember(OWNER);
    const res = await POST(postBody(validBody("no-such-agent", "conn-any")), routeContext());
    expect(res.status).toBe(404);
  });

  it("rejects an unknown connection id", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    const res = await POST(postBody(validBody(agent.id, "ghost-conn")), routeContext());
    expect(res.status).toBe(400);
    expect(await loadWorkflows(agent.id)).toHaveLength(0);
  });

  it("returns 401 for an unauthenticated caller", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await POST(postBody(validBody("a", "c")), routeContext());
    expect(res.status).toBe(401);
  });
});
