// Real-DB integration test for the four ADMIN-ONLY route families under
// /api/agents/[agentId]/ — knowledge/reindex, knowledge/unsearchable,
// integrations, and connecting a Telegram bot.
//
// The verdict these pin: an admin may NOT reach into another user's personal
// agent, not even on a management surface. `getVisibleAgents` withholds those
// agents from admins, `PATCH /api/agents/:id` — the only route that can set the
// `pinchy-files` grants the knowledge routes resolve their scope from — already
// answers 404, and so does `DELETE /api/agents/:id`. These four looked the
// agent up by id and proceeded, so an admin holding an id could reindex a
// stranger's Smithers, read the documents its index cannot search, grant it
// live access to an Odoo or email connection, and attach a Telegram bot to it.
//
// Each case issues BOTH requests — the personal agent of another user, and an
// id nobody ever issued — and asserts the two answers are equal. That equality
// is the contract; the 404 literal alongside it says which answer it is. Same
// shape as uploads-post.integration.test.ts, for the same reason: the mocked
// route tests stub `getAgentWithAccess`, so only a real DB proves the helper
// actually withholds the row.
//
// What stays mocked, and why:
//   - @/lib/auth (getSession) / next/headers — no real browser session exists
//     in a test process; withAuth/requireAdmin read it via headers().
//   - @/lib/enterprise, @/lib/groups — the personal-agent rule in
//     assertAgentAccess is decided before license state or group membership is
//     ever consulted, so leaving those real would only add table setup to a
//     question they do not answer.
//   - @/lib/knowledge/* , @/lib/telegram, @/lib/openclaw-config,
//     @/lib/telegram-allow-store — the side effects each route would have had
//     if the gate let it through. Mocked so that "nothing happened" is
//     assertable rather than merely likely: a refusal that still enqueued a job
//     or called Telegram would show up here.
//
// Everything else — the agents table, agent_connection_permissions, audit_log,
// and the real getAgentWithAccess — runs against the real database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("community"),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
  getAllAgentGroupIds: vi.fn().mockResolvedValue(new Map<string, string[]>()),
}));

// `deferAuditLog` wraps Next's `after()`, which throws outside a request scope
// — a route handler invoked directly from a test has none. Mocking it keeps the
// positive control (a shared agent really does get reindexed) exercisable, and
// makes "the refusal audited nothing" assertable rather than merely implied.
const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
  recordAuditFailure: vi.fn(),
}));

const mockEnqueueIndexJob = vi.fn();
const mockGetLatestIndexJobForAgent = vi.fn();
vi.mock("@/lib/knowledge/index-jobs", () => ({
  enqueueIndexJob: (...args: unknown[]) => mockEnqueueIndexJob(...args),
  getLatestIndexJobForAgent: (...args: unknown[]) => mockGetLatestIndexJobForAgent(...args),
}));

const mockListUnsearchableDocuments = vi.fn();
vi.mock("@/lib/knowledge/unsearchable", () => ({
  listUnsearchableDocuments: (...args: unknown[]) => mockListUnsearchableDocuments(...args),
}));

vi.mock("@/lib/knowledge/kb-embedder", () => ({
  kbEmbedderAvailable: () => true,
}));

const mockValidateTelegramBotToken = vi.fn();
vi.mock("@/lib/telegram", () => ({
  validateTelegramBotToken: (...args: unknown[]) => mockValidateTelegramBotToken(...args),
  hasMainTelegramBot: vi.fn().mockResolvedValue(true),
  probeTelegramPollingConflict: vi.fn().mockResolvedValue({ conflict: false }),
}));

const mockUpdateTelegramChannelConfig = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  updateTelegramChannelConfig: (...args: unknown[]) => mockUpdateTelegramChannelConfig(...args),
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram-allow-store", () => ({
  clearAllowStoreForAccount: vi.fn(),
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

// ── Real DB imports (loaded AFTER mocks are declared) ─────────────────────

import { db } from "@/db";
import { users, agents, agentConnectionPermissions, auditLog } from "@/db/schema";
import {
  POST as REINDEX_POST,
  GET as REINDEX_GET,
} from "@/app/api/agents/[agentId]/knowledge/reindex/route";
import { GET as UNSEARCHABLE_GET } from "@/app/api/agents/[agentId]/knowledge/unsearchable/route";
import {
  GET as INTEGRATIONS_GET,
  PUT as INTEGRATIONS_PUT,
  DELETE as INTEGRATIONS_DELETE,
} from "@/app/api/agents/[agentId]/integrations/route";
import {
  GET as TELEGRAM_GET,
  POST as TELEGRAM_POST,
} from "@/app/api/agents/[agentId]/channels/telegram/route";

// ── Helpers ────────────────────────────────────────────────────────────────

/** An id that is a well-formed UUID and belongs to no agent. */
const UNKNOWN_AGENT_ID = "00000000-0000-4000-8000-000000000000";

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `user-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      role: "member",
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Somebody else's Smithers, with knowledge-base grants on it. Real personal
 * agents are seeded without a `pluginConfig` and cannot be given one (PATCH is
 * gated, and the Permissions tab renders only for `isAdmin && !isPersonal`), so
 * granting paths here is deliberately MORE generous than production allows:
 * it makes the knowledge routes do real work if the gate ever lets them
 * through, instead of no-opping their way to a passing test.
 */
async function seedForeignPersonalAgent() {
  const owner = await seedUser({ name: "Owner" });
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      isPersonal: true,
      visibility: "restricted",
      ownerId: owner.id,
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
    })
    .returning();
  return row;
}

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

function makeRequest(agentId: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost/api/agents/${agentId}/x`, init);
}

function jsonBody(agentId: string, body: unknown) {
  return makeRequest(agentId, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Run `call` for another user's personal agent and for an unknown id, and
 * assert the two answers are byte-identical. Returns nothing: what a caller
 * asserts afterwards is that no side effect happened.
 */
async function expectIndistinguishable(
  foreignAgentId: string,
  call: (agentId: string) => Promise<Response>
) {
  const denied = await call(foreignAgentId);
  const unknown = await call(UNKNOWN_AGENT_ID);

  // The literal pins WHICH answer it is; the equality is the actual contract
  // and survives a later change of wording.
  expect(denied.status).toBe(404);
  expect(denied.status).toBe(unknown.status);
  expect(await denied.json()).toEqual(await unknown.json());
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockValidateTelegramBotToken.mockResolvedValue({
    valid: true,
    botId: 123456,
    botUsername: "test_bot",
  });
  mockEnqueueIndexJob.mockResolvedValue({ status: "queued", job: { id: "job-1" } });
  mockGetLatestIndexJobForAgent.mockResolvedValue(null);
  mockListUnsearchableDocuments.mockResolvedValue({ documents: [], total: 0 });

  const admin = await seedUser({ name: "Admin", role: "admin" });
  mockGetSession.mockResolvedValue({
    user: { id: admin.id, email: admin.email, role: "admin" },
  });
});

describe("admin-only agent management routes vs another user's personal agent (real DB)", () => {
  it("POST knowledge/reindex answers alike and queues nothing", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      REINDEX_POST(jsonBody(id, {}), makeParams(id))
    );

    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();
    // Not even the "nothing to index" no-op row, which would name the agent.
    expect(mockDeferAuditLog).not.toHaveBeenCalled();
  });

  it("GET knowledge/reindex answers alike and reads no job state", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) => REINDEX_GET(makeRequest(id), makeParams(id)));

    expect(mockGetLatestIndexJobForAgent).not.toHaveBeenCalled();
  });

  it("GET knowledge/unsearchable answers alike and never queries the index", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      UNSEARCHABLE_GET(makeRequest(id), makeParams(id))
    );

    expect(mockListUnsearchableDocuments).not.toHaveBeenCalled();
  });

  it("GET integrations answers alike", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      INTEGRATIONS_GET(makeRequest(id), makeParams(id))
    );
  });

  it("PUT integrations answers alike and grants no connection", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      INTEGRATIONS_PUT(
        jsonBody(id, {
          connectionId: "conn-1",
          permissions: [{ model: "res.partner", operation: "read" }],
        }),
        makeParams(id)
      )
    );

    const rows = await db
      .select()
      .from(agentConnectionPermissions)
      .where(eq(agentConnectionPermissions.agentId, foreign.id));
    expect(rows).toEqual([]);
  });

  it("DELETE integrations answers alike and writes no audit row", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      INTEGRATIONS_DELETE(makeRequest(id, { method: "DELETE" }), makeParams(id))
    );

    const rows = await db.select().from(auditLog);
    expect(rows).toEqual([]);
  });

  it("GET channels/telegram answers alike", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      TELEGRAM_GET(makeRequest(id), makeParams(id))
    );
  });

  it("POST channels/telegram answers alike and never reaches Telegram", async () => {
    const foreign = await seedForeignPersonalAgent();

    await expectIndistinguishable(foreign.id, (id) =>
      TELEGRAM_POST(jsonBody(id, { botToken: "123456:ABC-token" }), makeParams(id))
    );

    expect(mockValidateTelegramBotToken).not.toHaveBeenCalled();
    expect(mockUpdateTelegramChannelConfig).not.toHaveBeenCalled();
  });
});

describe("the same routes still serve an agent the admin may see (real DB)", () => {
  // The gate must not have turned "admin-only" into "owner-only": a shared
  // agent is exactly what these surfaces exist to manage, and a change that
  // closed them would pass every assertion above.
  async function seedSharedAgent() {
    const [row] = await db
      .insert(agents)
      .values({
        name: "Support Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        greetingMessage: "Hello!",
        isPersonal: false,
        visibility: "all",
        ownerId: null,
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
      })
      .returning();
    return row;
  }

  it("reindexes a shared agent's granted folders", async () => {
    const shared = await seedSharedAgent();

    const res = await REINDEX_POST(jsonBody(shared.id, {}), makeParams(shared.id));

    expect(res.status).toBe(202);
    expect(mockEnqueueIndexJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueIndexJob.mock.calls[0][0]).toMatchObject({
      agentId: shared.id,
      paths: ["/data/hr"],
    });
  });

  it("lists a shared agent's integrations", async () => {
    const shared = await seedSharedAgent();

    const res = await INTEGRATIONS_GET(makeRequest(shared.id), makeParams(shared.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("reports Telegram state for a shared agent", async () => {
    const shared = await seedSharedAgent();

    const res = await TELEGRAM_GET(makeRequest(shared.id), makeParams(shared.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });

  it("serves the admin's OWN personal agent — the main-bot setup flow depends on it", async () => {
    // telegram-link-settings.tsx sets the org's main bot up on the admin's own
    // Smithers, found via `/api/agents`. The owner branch of the read gate is
    // what keeps that flow working.
    const [session] = [await mockGetSession()];
    const [own] = await db
      .insert(agents)
      .values({
        name: "Smithers",
        model: "anthropic/claude-haiku-4-5-20251001",
        greetingMessage: "Hello!",
        isPersonal: true,
        visibility: "restricted",
        ownerId: session.user.id,
      })
      .returning();

    const res = await TELEGRAM_GET(makeRequest(own.id), makeParams(own.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, mainBotConfigured: true });
  });
});
