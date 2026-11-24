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
import { loadOpenClawDistExport } from "../helpers/openclaw-dist";

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

describe("openclaw config: internal hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));
  });

  it("keeps OpenClaw's internal hooks on", async () => {
    // The bundled internal hooks (session-memory, boot-md, command-logger, …)
    // run on every install that came from a Pinchy which forced this on.
    await regenerateOpenClawConfig();

    expect(writtenConfig().hooks?.internal?.enabled).toBe(true);
  });

  it("no longer loads hooks from /opt/pinchy-hooks", async () => {
    await regenerateOpenClawConfig();

    expect(writtenConfig().hooks?.internal?.load?.extraDirs ?? []).not.toContain(
      "/opt/pinchy-hooks"
    );
  });

  it("removes /opt/pinchy-hooks from a file an earlier Pinchy wrote, keeping everything else", async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        ...gatewayConfig,
        hooks: {
          internal: {
            enabled: true,
            entries: { "some-other-hook": { enabled: true } },
            load: { extraDirs: ["/opt/pinchy-hooks", "/somewhere/else"] },
          },
        },
      })
    );

    await regenerateOpenClawConfig();
    const config = writtenConfig();

    expect(config.hooks.internal.load.extraDirs).toEqual(["/somewhere/else"]);
    expect(config.hooks.internal.entries?.["some-other-hook"]).toEqual({ enabled: true });
  });

  it("drops the load block when /opt/pinchy-hooks was its only entry", async () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        ...gatewayConfig,
        hooks: { internal: { enabled: true, load: { extraDirs: ["/opt/pinchy-hooks"] } } },
      })
    );

    await regenerateOpenClawConfig();

    expect(writtenConfig().hooks.internal.load).toBeUndefined();
  });

  it(
    "OpenClaw itself keeps MEMORY.md out of group, channel, subagent and cron sessions",
    { timeout: 30_000 },
    async () => {
      // #369: a shared agent's MEMORY.md holds what individual users told it in
      // private chats, so it must never be pushed into a session other people
      // read. Pinchy used to ship an `agent:bootstrap` hook for this; OpenClaw's
      // own bootstrap filter covers it since openclaw/openclaw#108881, and this
      // test is what turns red if that ever stops being true.
      const filter = (await loadOpenClawDistExport(
        /^workspace-.*\.js$/,
        "filterBootstrapFilesForSession"
      )) as (files: { name: string; path: string }[], sessionKey: string) => { name: string }[];
      const files = ["MEMORY.md", "AGENTS.md"].map((name) => ({ name, path: `/ws/${name}` }));
      const names = (sessionKey: string) => filter(files, sessionKey).map((f) => f.name);

      expect(names("agent:a1:telegram:group:-100123")).not.toContain("MEMORY.md");
      expect(names("agent:a1:telegram:channel:-100999")).not.toContain("MEMORY.md");
      expect(names("agent:a1:subagent:s1")).not.toContain("MEMORY.md");
      expect(names("agent:a1:cron:j1")).not.toContain("MEMORY.md");
      // Direct chats keep it: that is where the memory belongs.
      expect(names("agent:a1:telegram:direct:42")).toContain("MEMORY.md");
      expect(names("agent:a1:direct:u1")).toContain("MEMORY.md");
    }
  );
});
