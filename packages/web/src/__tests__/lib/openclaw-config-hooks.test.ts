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
  getDefaultModel: vi.fn(async () => ""),
}));

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

function writtenConfig() {
  const written = mockedWriteFileSync.mock.calls[0][1] as string;
  return JSON.parse(written);
}

describe("openclaw config: internal hooks for the memory group filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));
  });

  it("enables internal hooks and loads the /opt/pinchy-hooks dir", async () => {
    await regenerateOpenClawConfig();
    const config = writtenConfig();

    expect(config.hooks?.internal?.enabled).toBe(true);
    expect(config.hooks?.internal?.load?.extraDirs).toContain("/opt/pinchy-hooks");
  });

  it("preserves OpenClaw-enriched hooks fields across a regenerate", async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        ...gatewayConfig,
        hooks: {
          internal: {
            entries: { "some-other-hook": { enabled: true } },
            load: { extraDirs: ["/somewhere/else"] },
          },
        },
      })
    );

    await regenerateOpenClawConfig();
    const config = writtenConfig();

    // Pinchy owns enabled + its own extraDir, but must not drop sibling state.
    expect(config.hooks.internal.enabled).toBe(true);
    expect(config.hooks.internal.entries?.["some-other-hook"]).toEqual({
      enabled: true,
    });
    expect(config.hooks.internal.load.extraDirs).toContain("/opt/pinchy-hooks");
    expect(config.hooks.internal.load.extraDirs).toContain("/somewhere/else");
  });

  it("does not duplicate /opt/pinchy-hooks when it is already present", async () => {
    // A repeated regenerate reads back its own previous output, so the merge
    // must stay idempotent — no growing extraDirs list across restarts.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        ...gatewayConfig,
        hooks: {
          internal: {
            enabled: true,
            load: { extraDirs: ["/opt/pinchy-hooks", "/somewhere/else"] },
          },
        },
      })
    );

    await regenerateOpenClawConfig();
    const config = writtenConfig();

    const dirs: string[] = config.hooks.internal.load.extraDirs;
    expect(dirs.filter((d) => d === "/opt/pinchy-hooks")).toHaveLength(1);
    expect(dirs).toContain("/somewhere/else");
  });
});
