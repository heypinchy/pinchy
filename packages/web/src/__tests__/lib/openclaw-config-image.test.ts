import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getDefaultModel: vi.fn(async () => ""),
}));

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedDb = vi.mocked(db);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

function mockAgents(agents: Array<Record<string, unknown>>) {
  mockedDb.select.mockReturnValue({
    from: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(agents), {
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

describe("pinchy-image config generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));
  });

  it("emits pinchy-image entry when at least one agent has an image_* tool", async () => {
    mockAgents([
      {
        id: "agent-1",
        name: "Bookkeeper",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["image_crop", "image_rotate"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.plugins?.entries?.["pinchy-image"]).toBeDefined();
    expect(config.plugins.entries["pinchy-image"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-image"].config.agents["agent-1"]).toEqual({
      tools: ["image_crop", "image_rotate"],
    });
  });

  it("does not emit pinchy-image entry when no agent has an image_* tool", async () => {
    mockAgents([
      {
        id: "agent-1",
        name: "Sales Analyst",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["odoo_read"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ]);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.plugins?.entries?.["pinchy-image"]).toBeUndefined();
  });
});
