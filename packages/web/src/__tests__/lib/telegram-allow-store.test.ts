import { describe, it, expect, vi, beforeEach } from "vitest";

// Since OpenClaw 2026.9 the allow lists and pairing requests live in its state
// database; the pinchy-audit plugin writes them for us over the gateway.
const { mockCallPairingStore } = vi.hoisted(() => ({ mockCallPairingStore: vi.fn() }));
vi.mock("@/lib/openclaw-pairing-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-pairing-store")>()),
  callPairingStore: mockCallPairingStore,
}));

// ── DB mocks ────────────────────────────────────────────────────────────

const mockDbSelect = vi.fn();
const mockDbSelectFrom = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  agents: "agents",
  users: "users",
  channelLinks: "channel_links",
  agentGroups: "agent_groups",
  userGroups: "user_groups",
  settings: "settings",
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn((_col, val) => ({ eq: val })),
    and: vi.fn((...args) => ({ and: args })),
    like: vi.fn((_col, val) => ({ like: val })),
    isNull: vi.fn((_col) => ({ isNull: true })),
    inArray: vi.fn((_col, vals) => ({ inArray: vals })),
  };
});

// Map-based settings mock: tests populate `mockSettings` with the keys they
// want present. `getSetting` reads it; `getSettingsByPrefix` filters it in one
// call (the production code batches bot-token lookups now — #261).
const mockSettings = new Map<string, string>();
const { mockGetSettingsByPrefix } = vi.hoisted(() => ({
  mockGetSettingsByPrefix: vi.fn((prefix: string, map: Map<string, string>) =>
    Promise.resolve(new Map(Array.from(map.entries()).filter(([k]) => k.startsWith(prefix))))
  ),
}));
vi.mock("@/lib/settings", () => ({
  getSetting: (key: string) => Promise.resolve(mockSettings.get(key) ?? null),
  getSettingsByPrefix: (prefix: string) => mockGetSettingsByPrefix(prefix, mockSettings),
  getSettingsByKeys: (keys: string[]) =>
    Promise.resolve(
      new Map(keys.flatMap((k) => (mockSettings.has(k) ? [[k, mockSettings.get(k)!]] : [])))
    ),
}));

import { OpenClawNotConnectedError } from "@/lib/openclaw-pairing-store";
import {
  removePairingRequest,
  recalculateTelegramAllowStores,
  clearAllowStoreForAccount,
  clearAllAllowStores,
} from "@/lib/telegram-allow-store";

const SET_ALLOW_FROM = "pinchy.pairing.setAllowFrom";

/** The params of every setAllowFrom call, oldest first. */
function allowFromWrites(): Array<{ allowFrom: Record<string, string[]>; replaceAll: boolean }> {
  return mockCallPairingStore.mock.calls
    .filter((c: unknown[]) => c[0] === SET_ALLOW_FROM)
    .map((c: unknown[]) => c[1] as { allowFrom: Record<string, string[]>; replaceAll: boolean });
}

/** The allow lists of the one setAllowFrom call the test expects. */
function writtenAllowFrom(): Record<string, string[]> {
  const writes = allowFromWrites();
  expect(writes).toHaveLength(1);
  return writes[0].allowFrom;
}

describe("telegram-allow-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallPairingStore.mockResolvedValue({});
  });

  describe("removePairingRequest", () => {
    it("removes the telegram user's pending requests through the gateway", async () => {
      await removePairingRequest("8754697762");

      expect(mockCallPairingStore).toHaveBeenCalledWith("pinchy.pairing.removeRequests", {
        requestId: "8754697762",
      });
    });

    it("does not throw while OpenClaw is disconnected", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new OpenClawNotConnectedError());

      await expect(removePairingRequest("8754697762")).resolves.toBeUndefined();
      warn.mockRestore();
    });

    it("does not throw when the gateway refuses, since the link itself already stands", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new Error("removeRequests failed: locked"));

      await expect(removePairingRequest("8754697762")).resolves.toBeUndefined();
      warn.mockRestore();
    });

    it("logs a warning when the removal fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new Error("removeRequests failed: locked"));

      await removePairingRequest("8754697762");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[telegram-allow-store]"),
        expect.any(String),
        expect.stringContaining("locked")
      );
      warn.mockRestore();
    });
  });

  // ── Per-account store functions ───────────────────────────────────

  describe("clearAllowStoreForAccount", () => {
    it("empties that account's list and leaves the other accounts alone", async () => {
      await clearAllowStoreForAccount("agent-1");

      expect(allowFromWrites()).toEqual([{ allowFrom: { "agent-1": [] }, replaceAll: false }]);
    });

    it("skips with a warning while OpenClaw is disconnected", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new OpenClawNotConnectedError());

      await expect(clearAllowStoreForAccount("agent-1")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[telegram-allow-store]"),
        expect.stringContaining("not connected")
      );
      warn.mockRestore();
    });

    // A revocation that did not land must not look like one that did.
    it("throws when the gateway refuses the write", async () => {
      mockCallPairingStore.mockRejectedValue(new Error("setAllowFrom failed: locked"));

      await expect(clearAllowStoreForAccount("agent-1")).rejects.toThrow(/locked/);
    });
  });

  describe("clearAllAllowStores", () => {
    it("empties every account's list", async () => {
      await clearAllAllowStores();

      expect(allowFromWrites()).toEqual([{ allowFrom: {}, replaceAll: true }]);
    });

    it("skips while OpenClaw is disconnected", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new OpenClawNotConnectedError());

      await expect(clearAllAllowStores()).resolves.toBeUndefined();
      warn.mockRestore();
    });

    it("throws when the gateway refuses the write", async () => {
      mockCallPairingStore.mockRejectedValue(new Error("setAllowFrom failed: locked"));

      await expect(clearAllAllowStores()).rejects.toThrow(/locked/);
    });
  });

  // ── Central recalculate function ──────────────────────────────────

  describe("recalculateTelegramAllowStores", () => {
    // Helper to set up mockDbSelect chain for multiple queries.
    // Each from() call gets its own where() closure to avoid shared-mock issues.
    function setupDbMocks(data: {
      agents?: Array<{
        id: string;
        visibility: string;
        isPersonal: boolean;
        deletedAt: string | null;
        avatarSeed: string | null;
      }>;
      channelLinks?: Array<{ userId: string; channelUserId: string }>;
      agentGroups?: Array<{ agentId: string; groupId: string }>;
      userGroups?: Array<{ userId: string; groupId: string }>;
      users?: Array<{ id: string; role: string; banned: boolean | null }>;
    }) {
      const tableData: Record<string, unknown[]> = {
        agents: data.agents || [],
        channel_links: data.channelLinks || [],
        agent_groups: data.agentGroups || [],
        user_groups: data.userGroups || [],
        users: data.users || [],
      };

      mockDbSelect.mockReturnValue({
        from: (table: string) => {
          const resolved = tableData[table] || [];
          const promise = Promise.resolve(resolved);
          return {
            where: () => Promise.resolve(resolved),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            [Symbol.toStringTag]: "Promise",
          };
        },
      });
    }

    beforeEach(() => {
      mockSettings.clear();
      // Re-wire the prefix spy after the outer clearAllMocks (its impl reads
      // mockSettings, which each test populates via mockSettings.set).
      mockGetSettingsByPrefix.mockImplementation((prefix: string) =>
        Promise.resolve(
          new Map(Array.from(mockSettings.entries()).filter(([k]) => k.startsWith(prefix)))
        )
      );
    });

    it("writes per-account store for agent with visibility 'all'", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [
          { userId: "user-1", channelUserId: "111222333" },
          { userId: "user-2", channelUserId: "444555666" },
        ],
        agentGroups: [],
        userGroups: [],
        users: [
          { id: "user-1", role: "member", banned: false },
          { id: "user-2", role: "member", banned: false },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      // Both users should be in agent-1's store (visibility: all)
      expect(writtenAllowFrom()["agent-1"]).toContain("111222333");
      expect(writtenAllowFrom()["agent-1"]).toContain("444555666");
    });

    it("restricts access for agent with visibility 'restricted' to group members", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "restricted",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [
          { userId: "user-1", channelUserId: "111222333" },
          { userId: "user-2", channelUserId: "444555666" },
        ],
        agentGroups: [{ agentId: "agent-1", groupId: "group-1" }],
        userGroups: [{ userId: "user-1", groupId: "group-1" }],
        // user-2 is NOT in group-1
        users: [
          { id: "user-1", role: "member", banned: false },
          { id: "user-2", role: "member", banned: false },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      // Only user-1 (in group) should have access
      expect(writtenAllowFrom()["agent-1"]).toContain("111222333");
      expect(writtenAllowFrom()["agent-1"]).not.toContain("444555666");
    });

    it("admins always get access to restricted agents", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "restricted",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [{ userId: "user-admin", channelUserId: "111222333" }],
        agentGroups: [{ agentId: "agent-1", groupId: "group-1" }],
        userGroups: [], // admin is NOT in group-1
        users: [{ id: "user-admin", role: "admin", banned: false }],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(writtenAllowFrom()["agent-1"]).toContain("111222333");
    });

    it("writes separate stores for multiple agents", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
          {
            id: "agent-2",
            visibility: "restricted",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [{ userId: "user-1", channelUserId: "111222333" }],
        agentGroups: [{ agentId: "agent-2", groupId: "group-1" }],
        userGroups: [{ userId: "user-1", groupId: "group-1" }],
        users: [{ id: "user-1", role: "member", banned: false }],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      mockSettings.set("telegram_bot_token:agent-2", "token-2");

      await recalculateTelegramAllowStores();

      const written = writtenAllowFrom();
      // agent-1 (visibility: all) → user has access
      expect(written["agent-1"]).toContain("111222333");
      // agent-2 (restricted, user in group) → user has access
      expect(written["agent-2"]).toContain("111222333");
    });

    it("skips agents without bot tokens", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
          {
            id: "agent-2",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [{ userId: "user-1", channelUserId: "111222333" }],
        agentGroups: [],
        userGroups: [],
        users: [{ id: "user-1", role: "member", banned: false }],
      });
      // Only agent-1 has a bot token
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(Object.keys(writtenAllowFrom())).toEqual(["agent-1"]);
    });

    // The write replaces the whole channel, so an account that no longer has a
    // bot (deleted agent, disconnected bot) loses its list by being left out.
    it("replaces the whole channel so accounts without a bot lose their list", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [],
        agentGroups: [],
        userGroups: [],
        users: [],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(allowFromWrites()).toEqual([{ allowFrom: { "agent-1": [] }, replaceAll: true }]);
    });

    // While the gateway is down nothing can be written; server.ts recalculates
    // on reconnect, so the change is not lost and the route must not fail.
    it("skips with a warning while OpenClaw is disconnected", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [],
        agentGroups: [],
        userGroups: [],
        users: [],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCallPairingStore.mockRejectedValue(new OpenClawNotConnectedError());

      await expect(recalculateTelegramAllowStores()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[telegram-allow-store]"),
        expect.stringContaining("not connected")
      );
      warn.mockRestore();
    });

    it("writes empty store when no linked users exist", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [],
        agentGroups: [],
        userGroups: [],
        users: [],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(writtenAllowFrom()["agent-1"]).toEqual([]);
    });

    it("clears the channel when no agent has a bot", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [],
        agentGroups: [],
        userGroups: [],
        users: [],
      });
      // no bot tokens — mockSettings is empty

      await recalculateTelegramAllowStores();

      expect(allowFromWrites()).toEqual([{ allowFrom: {}, replaceAll: true }]);
    });

    it("includes personal agents (e.g. Smithers) that have a bot token", async () => {
      setupDbMocks({
        agents: [
          {
            id: "smithers-1",
            visibility: "restricted",
            isPersonal: true,
            deletedAt: null,
            avatarSeed: "__smithers__",
          },
        ],
        channelLinks: [{ userId: "user-1", channelUserId: "111222333" }],
        agentGroups: [],
        userGroups: [],
        users: [{ id: "user-1", role: "member", banned: false }],
      });
      mockSettings.set("telegram_bot_token:smithers-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(writtenAllowFrom()["smithers-1"]).toContain("111222333");
    });

    it("leaves members off a personal-agent bot while members may not use a personal agent", async () => {
      // The personal-agent bot routes each linked user's DMs to THEIR OWN
      // Smithers. With that switched off, a member must not get through at all
      // — the routing fallback would otherwise hand them the bot owner's agent.
      setupDbMocks({
        agents: [
          {
            id: "smithers-1",
            visibility: "restricted",
            isPersonal: true,
            deletedAt: null,
            avatarSeed: "__smithers__",
          },
          {
            id: "shared-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [
          { userId: "member-1", channelUserId: "111" },
          { userId: "admin-1", channelUserId: "222" },
        ],
        users: [
          { id: "member-1", role: "member", banned: false },
          { id: "admin-1", role: "admin", banned: false },
        ],
      });
      mockSettings.set("telegram_bot_token:smithers-1", "token-1");
      mockSettings.set("telegram_bot_token:shared-1", "token-2");
      mockSettings.set("policy.member_personal_agents", "false");

      await recalculateTelegramAllowStores();

      const storeFor = (account: string) => writtenAllowFrom()[account];
      expect(storeFor("smithers-1")).toEqual(["222"]);
      // A shared agent's bot is not a personal agent; the switch leaves it alone.
      expect(storeFor("shared-1")).toEqual(["111", "222"]);
    });

    it("excludes banned users", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [
          { userId: "user-1", channelUserId: "111222333" },
          { userId: "user-banned", channelUserId: "444555666" },
        ],
        agentGroups: [],
        userGroups: [],
        users: [
          { id: "user-1", role: "member", banned: false },
          { id: "user-banned", role: "member", banned: true },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");

      await recalculateTelegramAllowStores();

      expect(writtenAllowFrom()["agent-1"]).toContain("111222333");
      expect(writtenAllowFrom()["agent-1"]).not.toContain("444555666");
    });

    it("fetches bot tokens in a single batched prefix query, not one getSetting per agent (#261)", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
          {
            id: "agent-2",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
          {
            id: "agent-3",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
        channelLinks: [{ userId: "user-1", channelUserId: "111222333" }],
        agentGroups: [],
        userGroups: [],
        users: [{ id: "user-1", role: "member", banned: false }],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      mockSettings.set("telegram_bot_token:agent-2", "token-2");
      mockSettings.set("telegram_bot_token:agent-3", "token-3");

      await recalculateTelegramAllowStores();

      // One batched prefix query — not one getSetting round-trip per agent.
      expect(mockGetSettingsByPrefix).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsByPrefix).toHaveBeenCalledWith("telegram_bot_token:", mockSettings);

      // All three agents' lists were still written from the batched result.
      expect(Object.keys(writtenAllowFrom()).sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    });

    // A revocation that did not land must surface, not pass as done.
    it("throws when the gateway refuses the write", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      mockCallPairingStore.mockRejectedValue(new Error("setAllowFrom failed: locked"));

      await expect(recalculateTelegramAllowStores()).rejects.toThrow(/locked/);
    });

    it("lets the next run through after a failed one", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      mockCallPairingStore.mockRejectedValueOnce(new Error("setAllowFrom failed: locked"));

      await expect(recalculateTelegramAllowStores()).rejects.toThrow();
      await expect(recalculateTelegramAllowStores()).resolves.toBeUndefined();
      expect(allowFromWrites()).toHaveLength(2);
    });

    // An older computation landing after a newer one would restore access
    // the newer one had just taken away.
    it("serializes concurrent runs so their writes land in call order", async () => {
      setupDbMocks({
        agents: [
          {
            id: "agent-1",
            visibility: "all",
            isPersonal: false,
            deletedAt: null,
            avatarSeed: null,
          },
        ],
      });
      mockSettings.set("telegram_bot_token:agent-1", "token-1");
      const order: string[] = [];
      let releaseFirst!: () => void;
      mockCallPairingStore
        .mockImplementationOnce(async () => {
          order.push("first:start");
          await new Promise<void>((r) => (releaseFirst = r));
          order.push("first:end");
          return {};
        })
        .mockImplementationOnce(async () => {
          order.push("second");
          return {};
        });

      const first = recalculateTelegramAllowStores();
      const second = recalculateTelegramAllowStores();
      await vi.waitFor(() => expect(order).toEqual(["first:start"]));
      releaseFirst();
      await Promise.all([first, second]);

      expect(order).toEqual(["first:start", "first:end", "second"]);
    });
  });
});
