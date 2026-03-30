import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockExistsSync,
  mockMkdirSync,
  mockUnlinkSync,
  mockReaddirSync,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReaddirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      renameSync: (...args: unknown[]) => mockRenameSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
      readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    },
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  };
});

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

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

import {
  addToAllowStore,
  removeFromAllowStore,
  clearAllowStore,
  removePairingRequest,
  recalculateTelegramAllowStores,
  getStorePathForAccount,
  clearAllowStoreForAccount,
  clearAllAllowStores,
} from "@/lib/telegram-allow-store";

describe("telegram-allow-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  // ── Legacy single-store functions (backward compat) ───────────────

  describe("addToAllowStore", () => {
    it("creates store with user when file does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      addToAllowStore("8754697762");

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, allowFrom: ["8754697762"] });
      // Atomic: writes tmp then renames
      expect(mockRenameSync).toHaveBeenCalledOnce();
    });

    it("adds user to existing store", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["111222333"] }));

      addToAllowStore("8754697762");

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.allowFrom).toEqual(["111222333", "8754697762"]);
    });

    it("does not duplicate existing user", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["8754697762"] }));

      addToAllowStore("8754697762");

      // Should not write if no change
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("creates credentials directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      addToAllowStore("8754697762");

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  describe("removeFromAllowStore", () => {
    it("removes user from store", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 1, allowFrom: ["8754697762", "111222333"] })
      );

      removeFromAllowStore("8754697762");

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.allowFrom).toEqual(["111222333"]);
    });

    it("does nothing if user not in store", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["111222333"] }));

      removeFromAllowStore("8754697762");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("does nothing if store does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      removeFromAllowStore("8754697762");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("clearAllowStore", () => {
    it("writes empty allowFrom array", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 1, allowFrom: ["8754697762", "111222333"] })
      );

      clearAllowStore();

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, allowFrom: [] });
    });

    it("does nothing if store does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      clearAllowStore();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("removePairingRequest", () => {
    it("removes pairing request for given telegram user ID", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          version: 1,
          requests: [
            { id: "8754697762", code: "ABC123", createdAt: "2026-01-01" },
            { id: "111222333", code: "XYZ789", createdAt: "2026-01-01" },
          ],
        })
      );

      removePairingRequest("8754697762");

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.requests).toHaveLength(1);
      expect(written.requests[0].id).toBe("111222333");
    });

    it("does nothing if user not in pairing store", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 1, requests: [{ id: "111222333", code: "XYZ" }] })
      );

      removePairingRequest("999999");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("does nothing if pairing file does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      removePairingRequest("8754697762");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  // ── Per-account store functions ───────────────────────────────────

  describe("getStorePathForAccount", () => {
    it("returns per-account store path", () => {
      const path = getStorePathForAccount("agent-1");
      expect(path).toContain("telegram-agent-1-allowFrom.json");
      expect(path).toContain("credentials");
    });
  });

  describe("clearAllowStoreForAccount", () => {
    it("writes empty allowFrom for specific account", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["8754697762"] }));

      clearAllowStoreForAccount("agent-1");

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, allowFrom: [] });
      // Verify it writes to the correct per-account path
      expect(mockWriteFileSync.mock.calls[0][0]).toContain("telegram-agent-1-allowFrom.json");
    });

    it("does nothing if account store does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      clearAllowStoreForAccount("agent-1");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("clearAllAllowStores", () => {
    it("clears all per-account store files", () => {
      mockReaddirSync.mockReturnValue([
        "telegram-agent-1-allowFrom.json",
        "telegram-agent-2-allowFrom.json",
        "telegram-pairing.json", // should be ignored
      ]);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["8754697762"] }));

      clearAllAllowStores();

      // Should write empty stores for both accounts (2 writes: tmp + rename each)
      const writeCallPaths = mockWriteFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writeCallPaths.filter((p: string) => p.includes("agent-1"))).toHaveLength(1);
      expect(writeCallPaths.filter((p: string) => p.includes("agent-2"))).toHaveLength(1);
    });

    it("also clears legacy store file if present", () => {
      mockReaddirSync.mockReturnValue([
        "telegram-allowFrom.json", // legacy
        "telegram-agent-1-allowFrom.json",
      ]);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["8754697762"] }));

      clearAllAllowStores();

      // Legacy + per-account = 2 writes
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
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
      mockGetSetting.mockResolvedValue(null);
      mockReaddirSync.mockReturnValue([]);
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      // Both users should be in agent-1's store (visibility: all)
      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      expect(accountWrite).toBeTruthy();
      const written = JSON.parse(accountWrite![1] as string);
      expect(written.allowFrom).toContain("111222333");
      expect(written.allowFrom).toContain("444555666");
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      expect(accountWrite).toBeTruthy();
      const written = JSON.parse(accountWrite![1] as string);
      // Only user-1 (in group) should have access
      expect(written.allowFrom).toContain("111222333");
      expect(written.allowFrom).not.toContain("444555666");
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      expect(accountWrite).toBeTruthy();
      const written = JSON.parse(accountWrite![1] as string);
      expect(written.allowFrom).toContain("111222333");
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
      mockGetSetting.mockImplementation((key: string) => {
        if (key === "telegram_bot_token:agent-1") return Promise.resolve("token-1");
        if (key === "telegram_bot_token:agent-2") return Promise.resolve("token-2");
        return Promise.resolve(null);
      });

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const agent1Write = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      const agent2Write = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-2-allowFrom.json")
      );

      expect(agent1Write).toBeTruthy();
      expect(agent2Write).toBeTruthy();

      // agent-1 (visibility: all) → user has access
      expect(JSON.parse(agent1Write![1] as string).allowFrom).toContain("111222333");
      // agent-2 (restricted, user in group) → user has access
      expect(JSON.parse(agent2Write![1] as string).allowFrom).toContain("111222333");
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writePaths = mockWriteFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writePaths.some((p: string) => p.includes("agent-1"))).toBe(true);
      expect(writePaths.some((p: string) => p.includes("agent-2"))).toBe(false);
    });

    it("cleans up orphaned store files for agents without bots", async () => {
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );
      // Orphaned store file for agent that no longer has a bot
      mockReaddirSync.mockReturnValue([
        "telegram-agent-1-allowFrom.json",
        "telegram-deleted-agent-allowFrom.json",
      ]);

      await recalculateTelegramAllowStores();

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("telegram-deleted-agent-allowFrom.json")
      );
    });

    it("deletes legacy store file", async () => {
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );
      mockReaddirSync.mockReturnValue([
        "telegram-allowFrom.json", // legacy
        "telegram-agent-1-allowFrom.json",
      ]);

      await recalculateTelegramAllowStores();

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("telegram-allowFrom.json")
      );
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      expect(accountWrite).toBeTruthy();
      const written = JSON.parse(accountWrite![1] as string);
      expect(written.allowFrom).toEqual([]);
    });

    it("does nothing when no agents have bots", async () => {
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
      mockGetSetting.mockResolvedValue(null); // no bot tokens

      await recalculateTelegramAllowStores();

      // No per-account writes (only potential cleanup)
      const writePaths = mockWriteFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writePaths.some((p: string) => p.includes("telegram-agent"))).toBe(false);
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:smithers-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-smithers-1-allowFrom.json")
      );
      expect(accountWrite).toBeTruthy();
      const written = JSON.parse(accountWrite![1] as string);
      expect(written.allowFrom).toContain("111222333");
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
      mockGetSetting.mockImplementation((key: string) =>
        key === "telegram_bot_token:agent-1" ? Promise.resolve("token-1") : Promise.resolve(null)
      );

      await recalculateTelegramAllowStores();

      const writeCalls = mockWriteFileSync.mock.calls;
      const accountWrite = writeCalls.find((c: unknown[]) =>
        (c[0] as string).includes("telegram-agent-1-allowFrom.json")
      );
      const written = JSON.parse(accountWrite![1] as string);
      expect(written.allowFrom).toContain("111222333");
      expect(written.allowFrom).not.toContain("444555666");
    });
  });
});
