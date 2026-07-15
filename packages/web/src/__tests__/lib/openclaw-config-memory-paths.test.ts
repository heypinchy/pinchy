import { describe, it, expect, vi, beforeEach } from "vitest";

// Retrofit of the agent memory paths (MEMORY.md, memory/) onto workspaces that
// already exist.
//
// ensureWorkspace only runs at agent-create time, so teaching it to create the
// memory paths fixes future agents and no existing one. Every agent already in
// the field would keep hitting the denial. regenerateOpenClawConfig runs on
// boot and on every agent/settings mutation, and is where the memory grants are
// emitted in the first place — so it is where the paths those grants point at
// get materialized.
//
// The fs mock is STATEFUL (fileStore + dirStore) because that is the whole
// point: these tests assert against a workspace that already has content, which
// AGENTS.md ("Test Migrations Against Pre-Existing Data") requires whenever
// behaviour changes for data written by older code.

const { fileStore, dirStore } = vi.hoisted(() => ({
  fileStore: new Map<string, string>(),
  dirStore: new Set<string>(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn((p: unknown, content: unknown) => {
    fileStore.set(String(p), String(content));
  });
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn((p: unknown) => fileStore.has(String(p)) || dirStore.has(String(p)));
  const mkdirSyncMock = vi.fn((p: unknown) => {
    dirStore.add(String(p));
  });
  const renameSyncMock = vi.fn((from: unknown, to: unknown) => {
    const content = fileStore.get(String(from));
    if (content !== undefined) fileStore.set(String(to), content);
    fileStore.delete(String(from));
  });
  const rmSyncMock = vi.fn((p: unknown) => {
    fileStore.delete(String(p));
  });
  const unlinkSyncMock = vi.fn((p: unknown) => {
    fileStore.delete(String(p));
  });
  const chmodSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      renameSync: renameSyncMock,
      rmSync: rmSyncMock,
      unlinkSync: unlinkSyncMock,
      chmodSync: chmodSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    rmSync: rmSyncMock,
    unlinkSync: unlinkSyncMock,
    chmodSync: chmodSyncMock,
  };
});

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingsByPrefix: vi.fn().mockResolvedValue(new Map()),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
  return {
    ...actual,
    writeSecretsFile: vi.fn(),
    readSecretsFile: vi.fn().mockReturnValue({}),
  };
});

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn(async () => "anthropic/claude-haiku-4-5-20251001"),
}));

import { readFileSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedDb = vi.mocked(db);

const CONFIG_PATH = "/openclaw-config/openclaw.json";
const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

const workspace = (agentId: string) => `/openclaw-config/workspaces/${agentId}`;
const memoryDir = (agentId: string) => `${workspace(agentId)}/memory`;
const memoryFile = (agentId: string) => `${workspace(agentId)}/MEMORY.md`;

function mockDb(agentsData: Array<Record<string, unknown>>) {
  mockedDb.select.mockReturnValue({
    from: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(agentsData), {
        innerJoin: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            where: vi.fn().mockResolvedValue([]),
          })
        ),
        where: vi.fn().mockResolvedValue([]),
      })
    ),
  } as never);
}

function agentRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    model: "anthropic/claude-haiku-4-5-20251001",
    allowedTools: ["pinchy_write"],
    pluginConfig: null,
    ownerId: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * A workspace as older code left it: uploads/, workbench/ and the two bootstrap
 * files, but no MEMORY.md and no memory/. This is the exact on-disk shape of
 * every agent created before the memory paths were granted.
 */
function seedLegacyWorkspace(agentId: string) {
  dirStore.add(workspace(agentId));
  dirStore.add(`${workspace(agentId)}/uploads`);
  dirStore.add(`${workspace(agentId)}/workbench`);
  fileStore.set(`${workspace(agentId)}/SOUL.md`, "You are a helpful assistant.");
  fileStore.set(`${workspace(agentId)}/AGENTS.md`, "Answer questions about our docs.");
}

describe("regenerateOpenClawConfig materializes the agent memory paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileStore.clear();
    dirStore.clear();
    mockedReadFileSync.mockImplementation((p) => {
      const path = String(p);
      const stored = fileStore.get(path);
      if (stored !== undefined) return stored;
      if (path.endsWith("openclaw.json")) return JSON.stringify(gatewayConfig);
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });
  });

  it("creates memory/ and MEMORY.md on a workspace that predates the memory grants", async () => {
    // The regression, exactly: build.ts grants these two paths to a
    // write-capable agent and memory-prompt.ts tells the agent it may use
    // them, but nothing ever created them, so pinchy-files rejected every
    // memory write as a sandbox escape.
    seedLegacyWorkspace("scout");
    mockDb([agentRow("scout")]);

    await regenerateOpenClawConfig();

    expect(dirStore.has(memoryDir("scout"))).toBe(true);
    expect(fileStore.get(memoryFile("scout"))).toBe("");
  });

  it("leaves an existing MEMORY.md untouched", async () => {
    // The retrofit runs on every boot and every agent mutation, so a
    // clobbering version of it would erase an agent's accumulated memory
    // on the next restart rather than on first contact — the kind of data
    // loss that surfaces long after the deploy that caused it.
    seedLegacyWorkspace("scout");
    fileStore.set(memoryFile("scout"), "- The user prefers concise answers.\n");
    mockDb([agentRow("scout")]);

    await regenerateOpenClawConfig();

    expect(fileStore.get(memoryFile("scout"))).toBe("- The user prefers concise answers.\n");
  });

  it("grants and materializes the same paths, so the config never points at a missing directory", async () => {
    // The bug was a disagreement between what the config promised and what
    // existed on disk. Assert the two agree rather than assuming they do.
    seedLegacyWorkspace("scout");
    mockDb([agentRow("scout")]);

    await regenerateOpenClawConfig();

    const written = fileStore.get(CONFIG_PATH);
    if (!written) throw new Error("openclaw.json was never written");
    const config = JSON.parse(written) as {
      plugins: {
        entries: Record<string, { config: { agents: Record<string, { write_paths?: string[] }> } }>;
      };
    };
    const writePaths = config.plugins.entries["pinchy-files"].config.agents.scout.write_paths ?? [];

    // The config speaks OpenClaw's side of the shared volume, the filesystem
    // Pinchy's; same bytes, different mount point.
    const granted = writePaths.map((p) =>
      p.replace("/root/.openclaw/workspaces", "/openclaw-config/workspaces")
    );
    expect(granted).toContain(memoryDir("scout"));
    expect(granted).toContain(memoryFile("scout"));
    for (const path of granted) {
      expect(dirStore.has(path) || fileStore.has(path)).toBe(true);
    }
  });

  it("does not create memory paths for a soft-deleted agent", async () => {
    // Tombstoned agents are excluded from every other emission for the same
    // reason (see the liveAgents note in build.ts); the retrofit must not
    // resurrect their workspaces.
    mockDb([agentRow("ghost", { deletedAt: new Date() })]);

    await regenerateOpenClawConfig();

    expect(dirStore.has(memoryDir("ghost"))).toBe(false);
    expect(fileStore.has(memoryFile("ghost"))).toBe(false);
  });
});
