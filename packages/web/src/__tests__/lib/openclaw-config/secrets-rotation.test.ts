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

const { mockWriteSecretsFile } = vi.hoisted(() => ({
  mockWriteSecretsFile: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
  return {
    ...actual,
    writeSecretsFile: mockWriteSecretsFile,
    readSecretsFile: vi.fn().mockReturnValue({}),
  };
});

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn(async () => ""),
}));

const { mockGetClient, mockConfigGet, mockConfigApply, mockRequest } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockConfigGet: vi.fn(),
  mockConfigApply: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import {
  writtenOpenClawConfig,
  findOpenClawConfigWrite,
} from "../../helpers/openclaw-config-write";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

/** The pushes are fire-and-forget; let their microtasks run. */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/**
 * Runs one regenerate against `gatewayConfig` and returns the config bytes it
 * emitted, so a follow-up regenerate can be given an on-disk file that is
 * genuinely identical to what it will produce. Reproducing THAT state is the
 * whole point: a key rotation on an already-configured provider leaves the
 * emitted config byte-identical, which is why nothing reached the runtime.
 */
async function settleOnDiskConfig(): Promise<string> {
  mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));
  await regenerateOpenClawConfig();
  await drain();
  return writtenOpenClawConfig(mockedWriteFileSync);
}

describe("provider key rotation reaches the OpenClaw runtime (#943)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockWriteSecretsFile.mockReturnValue(false);
    mockGetClient.mockImplementation(() => {
      throw new Error("OpenClaw client not initialized");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("asks OpenClaw to reload its secrets when only the secrets bundle changed", async () => {
    const onDisk = await settleOnDiskConfig();

    // Second pass: the rotated key changed secrets.json and nothing else. The
    // emitted config equals the file on disk, so every config-level change
    // detector correctly sees a no-op — and before #943 that meant the running
    // OpenClaw kept serving the revoked key until someone restarted it.
    vi.clearAllMocks();
    mockedReadFileSync.mockReturnValue(onDisk);
    mockWriteSecretsFile.mockReturnValue(true);
    mockRequest.mockResolvedValue({ type: "res", id: "1", ok: true, payload: {} });
    mockGetClient.mockReturnValue({
      config: { get: mockConfigGet, apply: mockConfigApply },
      hasMethod: () => true,
      request: mockRequest,
    });

    await regenerateOpenClawConfig();
    await drain();

    expect(mockRequest).toHaveBeenCalledWith("secrets.reload");
  });

  it("leaves the config no-op guard alone — no config.apply for a secrets-only change", async () => {
    // The guard exists because OpenClaw 5.3 rate-limits config.apply at ~3
    // calls per 45 s and a wasted slot has real cost. Fixing the rotation must
    // not buy the fix by spending that slot: secrets.reload is not a
    // control-plane write, so it costs nothing from that budget.
    const onDisk = await settleOnDiskConfig();

    vi.clearAllMocks();
    mockedReadFileSync.mockReturnValue(onDisk);
    mockWriteSecretsFile.mockReturnValue(true);
    mockRequest.mockResolvedValue({ type: "res", id: "1", ok: true, payload: {} });
    mockConfigGet.mockResolvedValue({ hash: "h1", config: JSON.parse(onDisk) });
    mockGetClient.mockReturnValue({
      config: { get: mockConfigGet, apply: mockConfigApply },
      hasMethod: () => true,
      request: mockRequest,
    });

    await regenerateOpenClawConfig();
    await drain();

    expect(mockConfigApply).not.toHaveBeenCalled();
    expect(findOpenClawConfigWrite(mockedWriteFileSync)).toBeUndefined();
  });

  it("does not reload secrets on a genuine no-op regenerate", async () => {
    // Nothing changed at all — not the config, not the secrets. Firing the RPC
    // here would put an unnecessary round trip (and a channel restart check) on
    // every boot and every unrelated settings save.
    //
    // This is also the deletion path: `writeSecretsFile` deliberately reports
    // `false` for a write that only REMOVES values, because a reload would then
    // fail on the pointer still present in OpenClaw's running config. Which
    // write reports what is pinned in openclaw-secrets.test.ts.
    const onDisk = await settleOnDiskConfig();

    vi.clearAllMocks();
    mockedReadFileSync.mockReturnValue(onDisk);
    mockWriteSecretsFile.mockReturnValue(false);
    mockGetClient.mockReturnValue({
      config: { get: mockConfigGet, apply: mockConfigApply },
      hasMethod: () => true,
      request: mockRequest,
    });

    await regenerateOpenClawConfig();
    await drain();

    expect(mockRequest).not.toHaveBeenCalled();
  });
});
