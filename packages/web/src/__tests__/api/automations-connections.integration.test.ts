// Real-DB integration tests for GET /api/automations/connections?agentId= — the
// mailbox choices the Automations create form (#139) renders in its picker.
//
// Why real DB, not mocked chains: the load-bearing behavior is the SAME
// permission resolution the create route enforces (agent_connection_permissions
// where model="email" and operation ∈ EMAIL_READ_OPERATIONS), plus scope-based
// RBAC. If the picker offered a connection the create route rejects — or hid one
// it accepts — a user could only fail. So the two must resolve identically, and
// only a real query proves that. @/lib/auth is mocked to drive the scope
// branches deterministically.
import { describe, it, expect, vi, beforeEach } from "vitest";

import { db } from "@/db";
import { agents, users, agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { makeNextRequest, routeContext } from "@/test-helpers/route";
import type { AgentVisibility } from "@/db/enums";

const { getSessionMock, licenseStateMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  licenseStateMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  auth: { api: { getSession: getSessionMock } },
}));

// Only the license STATE is replaced. The visibility half of the access gate is
// live only on a LICENSED instance — a community instance maps "restricted" to
// "all" (agent-access.effectiveVisibility) — so a suite that inherited the state
// could not tell a visibility denial from a scope denial, and would stay green
// whichever one the route produced.
vi.mock("@/lib/enterprise", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enterprise")>()),
  getLicenseState: licenseStateMock,
}));

const { GET } = await import("@/app/api/automations/connections/route");

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
async function seedConnection(id: string, name: string) {
  await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name, credentials: "enc:placeholder" });
}
async function grantEmailPermission(agentId: string, connectionId: string, operation = "read") {
  await db
    .insert(agentConnectionPermissions)
    .values({ agentId, connectionId, model: "email", operation });
}

function req(agentId?: string) {
  const url = agentId
    ? `http://localhost/api/automations/connections?agentId=${agentId}`
    : `http://localhost/api/automations/connections`;
  return makeNextRequest(url, { method: "GET" });
}

describe("GET /api/automations/connections", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    licenseStateMock.mockResolvedValue("paid");
    await seedUser(OWNER);
    await seedUser(OTHER);
    await seedUser(ADMIN, "admin");
  });

  it("returns the email-readable connections (id + name) for a member's own personal agent", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-a", "Invoices mailbox");
    await grantEmailPermission(agent.id, "conn-a", "read");

    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: "conn-a", name: "Invoices mailbox" }]);
  });

  it("excludes a connection whose only email grant is send — the picker must match the create gate", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-read", "Readable");
    await seedConnection("conn-send", "Send only");
    await grantEmailPermission(agent.id, "conn-read", "read");
    await grantEmailPermission(agent.id, "conn-send", "send");

    const res = await GET(req(agent.id), routeContext());
    const body = await res.json();
    expect(body).toEqual([{ id: "conn-read", name: "Readable" }]);
  });

  it("treats legacy search/list operations as read and returns each connection once", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    await seedConnection("conn-legacy", "Legacy mailbox");
    // Same connection granted under two read-alias operations — must not double up.
    await grantEmailPermission(agent.id, "conn-legacy", "search");
    await grantEmailPermission(agent.id, "conn-legacy", "list");

    const res = await GET(req(agent.id), routeContext());
    const body = await res.json();
    expect(body).toEqual([{ id: "conn-legacy", name: "Legacy mailbox" }]);
  });

  it("returns an empty list when the agent has no email-readable connection", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    // Agent exists and is manageable, but holds no email read grant at all.
    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns connections sorted by name so the picker order is stable", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    // Insert deliberately out of alphabetical order — the route must sort.
    await seedConnection("conn-z", "Zebra mailbox");
    await seedConnection("conn-a", "Alpha mailbox");
    await grantEmailPermission(agent.id, "conn-z", "read");
    await grantEmailPermission(agent.id, "conn-a", "read");

    const res = await GET(req(agent.id), routeContext());
    expect(await res.json()).toEqual([
      { id: "conn-a", name: "Alpha mailbox" },
      { id: "conn-z", name: "Zebra mailbox" },
    ]);
  });

  it("forbids a member from listing the connections of a shared agent they CAN see", async () => {
    // visibility "all" on purpose: the member can see this agent, so the 403
    // pins the SCOPE rule and nothing else.
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "all" });
    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(403);
    // Read-side default wording from the shared gate (#1087).
    expect(await res.json()).toEqual({ error: "You do not have access to this agent" });
  });

  it("answers 404 for another user's personal agent — never confirms it exists", async () => {
    // Personal, owned by someone else: hidden from every caller, admins
    // included, so a 403 would disclose the one thing nothing else in the
    // product does — that this id is a real agent (#880).
    asMember(OTHER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });
    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(404);
  });

  it("answers 404 for a restricted shared agent outside the member's groups", async () => {
    asMember(OWNER);
    const agent = await seedAgent({ isPersonal: false, ownerId: null, visibility: "restricted" });
    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(404);
  });

  it("answers an agent it may not see byte-identically to one that does not exist", async () => {
    asMember(OTHER);
    const agent = await seedAgent({ isPersonal: true, ownerId: OWNER });

    const denied = await GET(req(agent.id), routeContext());
    const missing = await GET(req("no-such-agent"), routeContext());

    // Pinned explicitly, not only compared: two equal statuses prove the oracle
    // closed only once we know WHICH status they agree on.
    expect(denied.status).toBe(404);
    expect(denied.status).toBe(missing.status);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it("lets an admin list a shared agent's connections", async () => {
    asAdmin(ADMIN);
    const agent = await seedAgent({ isPersonal: false, ownerId: null });
    await seedConnection("conn-shared", "Shared mailbox");
    await grantEmailPermission(agent.id, "conn-shared", "read");

    const res = await GET(req(agent.id), routeContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "conn-shared", name: "Shared mailbox" }]);
  });

  it("requires an agentId query parameter", async () => {
    asMember(OWNER);
    const res = await GET(req(), routeContext());
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown agent", async () => {
    asMember(OWNER);
    const res = await GET(req("ghost"), routeContext());
    expect(res.status).toBe(404);
  });
});
