import { describe, it, expect, vi, beforeEach } from "vitest";

// Issue #373: regenerateOpenClawConfig must emit a per-agent bootstrapMaxChars
// sized to the agent's on-disk AGENTS.md so OpenClaw injects the full
// instructions instead of truncating them (and leaking a "…truncated…" marker).

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
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
      chmodSync: chmodSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
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
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

const { mockDecrypt } = vi.hoisted(() => ({
  mockDecrypt: vi.fn((val: string) => val),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => mockDecrypt(val),
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

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import {
  OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS,
  BOOTSTRAP_PER_FILE_CEILING_CHARS,
} from "@/lib/openclaw-config/bootstrap-caps";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedDb = vi.mocked(db);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

function mockSingleAgent(agentId: string) {
  const agentsData = [
    {
      id: agentId,
      name: "Master Prompt Agent",
      model: "anthropic/claude-haiku-4-5-20251001",
      allowedTools: [],
      pluginConfig: {},
      ownerId: null,
      createdAt: new Date(),
    },
  ];
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

/** Route reads: openclaw.json → existing config; <id>/AGENTS.md → agentsMd; else "". */
function mockFsReads(agentsMdByAgent: Record<string, string>) {
  mockedExistsSync.mockReturnValue(true);
  mockedReadFileSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith(".json")) return JSON.stringify(gatewayConfig);
    if (path.endsWith("/AGENTS.md")) {
      const entry = Object.entries(agentsMdByAgent).find(([id]) => path.includes(id));
      return entry ? entry[1] : "";
    }
    return "";
  });
}

function getAgentEntry(agentId: string) {
  const written = mockedWriteFileSync.mock.calls[0][1] as string;
  const config = JSON.parse(written);
  return config.agents.list.find((a: { id: string }) => a.id === agentId);
}

describe("regenerateOpenClawConfig bootstrap caps (Issue #373)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockImplementation((val: string) => val);
  });

  it("emits bootstrapMaxChars fitting an AGENTS.md larger than OpenClaw's default cap", async () => {
    mockSingleAgent("big-agent");
    mockFsReads({ "big-agent": "x".repeat(30_000) });

    await regenerateOpenClawConfig();

    const entry = getAgentEntry("big-agent");
    expect(entry.bootstrapMaxChars).toBe(30_000);
    expect(entry.bootstrapMaxChars).toBeGreaterThan(OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS);
  });

  it("does not emit bootstrap caps for an AGENTS.md within the default budget", async () => {
    mockSingleAgent("small-agent");
    mockFsReads({ "small-agent": "short instructions" });

    await regenerateOpenClawConfig();

    const entry = getAgentEntry("small-agent");
    expect(entry.bootstrapMaxChars).toBeUndefined();
    expect(entry.bootstrapTotalMaxChars).toBeUndefined();
  });

  it("clamps an extreme AGENTS.md to the per-file ceiling", async () => {
    mockSingleAgent("huge-agent");
    mockFsReads({ "huge-agent": "y".repeat(500_000) });

    await regenerateOpenClawConfig();

    const entry = getAgentEntry("huge-agent");
    expect(entry.bootstrapMaxChars).toBe(BOOTSTRAP_PER_FILE_CEILING_CHARS);
  });
});
