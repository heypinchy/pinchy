// The WS chat path must see a license change the moment the key is saved
// (#1277).
//
// The custom server imports ClientRouter, and with it `@/lib/enterprise`, in a
// different module graph from the Next route that saves the key and clears the
// license cache. While that cache was module-level, the clear reached only the
// route's copy: right after an admin entered their first license and
// restricted an agent to a group, the chat server still read "community",
// mapped "restricted" to "all", and let every member chat with the agent for
// up to an hour.
//
// This drives the real ClientRouter with the real license cache and the real
// access check. The route's instance is a second import after
// `vi.resetModules()`, exactly as the process has two.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { DEV_LICENSE_TOKEN } from "@/lib/license-keys";

const mocks = vi.hoisted(() => ({
  storedKey: null as string | null,
  findAgent: vi.fn(),
  chat: vi.fn(),
  getUserGroupIds: vi.fn(),
  getAgentGroupIds: vi.fn(),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => (key === "enterprise_key" ? mocks.storedKey : null)),
}));
vi.mock("@/lib/groups", () => ({
  getUserGroupIds: mocks.getUserGroupIds,
  getAgentGroupIds: mocks.getAgentGroupIds,
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: mocks.appendAuditLog,
}));
vi.mock("@/lib/instance-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-policy")>()),
  getInstancePolicy: vi.fn().mockResolvedValue({
    memberPersonalAgents: true,
    memberAutomations: true,
  }),
}));
vi.mock("@/lib/budgets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budgets")>()),
  getExhaustedBlockingBudget: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/db", () => ({
  db: {
    query: {
      agents: { findFirst: mocks.findAgent },
      users: { findFirst: vi.fn().mockResolvedValue({ id: "member-1", context: null }) },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
  },
}));

const veterinaryAgent = {
  id: "agent-vet",
  name: "Veterinary",
  ownerId: null,
  isPersonal: false,
  visibility: "restricted",
  greetingMessage: null,
};

function openClawClient() {
  return Object.assign(new EventEmitter(), {
    chat: mocks.chat,
    sessions: { history: vi.fn(), list: vi.fn() },
    hasMethod: () => false,
    agents: { list: vi.fn() },
    request: vi.fn().mockResolvedValue({ payload: {} }),
    isConnected: true,
  });
}

function clientWs() {
  const sent: Array<{ type: string; message?: string }> = [];
  return {
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    close: vi.fn(),
    readyState: 1,
    sent,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storedKey = null;
  mocks.findAgent.mockResolvedValue(veterinaryAgent);
  // The member is in "Food Diagnostics"; the agent is restricted to "Veterinary".
  mocks.getUserGroupIds.mockResolvedValue(["group-food"]);
  mocks.getAgentGroupIds.mockResolvedValue(["group-vet"]);
  mocks.chat.mockImplementation(async function* () {
    yield { type: "text" as const, text: "Hello." };
    yield { type: "done" as const, text: "" };
  });
});

describe("ClientRouter after a license key is entered (#1277)", () => {
  it("enforces a group restriction on the first message after the key is saved", async () => {
    // The chat server's module graph, loaded at boot.
    vi.resetModules();
    const { ClientRouter } = await import("@/server/client-router");
    const { SessionCache } = await import("@/server/session-cache");
    const sessionCache = new SessionCache();
    sessionCache.refresh([{ key: "agent:agent-vet:direct:member-1" }]);
    const router = new ClientRouter(openClawClient() as never, "member-1", "member", sessionCache);

    // Community: "restricted" is the DB default and means "all", so the member
    // may chat. This also warms the chat server's license cache.
    const before = clientWs();
    await router.handleMessage(before as never, {
      type: "message",
      content: "Hi",
      agentId: "agent-vet",
    });
    expect(mocks.chat).toHaveBeenCalledTimes(1);

    // The admin enters a license. PUT /api/enterprise/key stores it and clears
    // the cache through the ROUTE bundle's instance of `@/lib/enterprise`.
    mocks.storedKey = DEV_LICENSE_TOKEN;
    vi.resetModules();
    const routeEnterprise = await import("@/lib/enterprise");
    routeEnterprise.clearLicenseCache();
    expect(await routeEnterprise.getLicenseState()).not.toBe("community");

    // The member's next message must be refused — not an hour later.
    mocks.chat.mockClear();
    const after = clientWs();
    await router.handleMessage(after as never, {
      type: "message",
      content: "Hi again",
      agentId: "agent-vet",
    });

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(after.sent).toContainEqual({ type: "error", message: "Agent not found" });
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.denied",
        resource: "agent:agent-vet",
        outcome: "failure",
      })
    );
  });
});
