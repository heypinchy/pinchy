import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const unlinkSyncMock = vi.fn();
  const writeFileSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      unlinkSync: unlinkSyncMock,
      writeFileSync: writeFileSyncMock,
    },
    existsSync: existsSyncMock,
    unlinkSync: unlinkSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

import { existsSync, unlinkSync, writeFileSync } from "fs";
import { migrateToSecretRef } from "@/lib/openclaw-migration";

const mockedExistsSync = vi.mocked(existsSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

describe("migrateToSecretRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("deletes openclaw.json.bak on first run", () => {
    const configPath = "/openclaw-config/openclaw.json";
    const bakPath = `${configPath}.bak`;
    const markerPath = "/openclaw-config/.secret-ref-migrated-v1";

    mockedExistsSync.mockImplementation((p) => {
      if (p === markerPath) return false;
      if (p === bakPath) return true;
      return false;
    });

    migrateToSecretRef(configPath);

    expect(mockedUnlinkSync).toHaveBeenCalledWith(bakPath);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      markerPath,
      expect.stringMatching(/^migrated at /)
    );
  });

  it("writes the marker file even when no .bak file exists", () => {
    const configPath = "/openclaw-config/openclaw.json";
    const markerPath = "/openclaw-config/.secret-ref-migrated-v1";

    mockedExistsSync.mockReturnValue(false);

    migrateToSecretRef(configPath);

    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      markerPath,
      expect.stringMatching(/^migrated at /)
    );
  });

  it("is idempotent — second run does nothing", () => {
    const configPath = "/openclaw-config/openclaw.json";
    const markerPath = "/openclaw-config/.secret-ref-migrated-v1";

    // First run: no marker, no .bak
    mockedExistsSync.mockReturnValue(false);
    migrateToSecretRef(configPath);

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    // Second run: marker exists
    mockedExistsSync.mockImplementation((p) => p === markerPath);
    migrateToSecretRef(configPath);

    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});
