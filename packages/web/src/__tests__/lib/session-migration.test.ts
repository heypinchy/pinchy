import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const readdirSyncMock = vi.fn().mockReturnValue([]);
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      readdirSync: readdirSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  };
});

import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { migrateSessionKeys } from "@/lib/session-migration";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);

describe("migrateSessionKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("should rename user- keys to direct: format", () => {
    mockedReaddirSync.mockReturnValue(["agent-1"] as unknown as ReturnType<typeof readdirSync>);
    const sessions = {
      "agent:agent-1:user-uid-123": { sessionId: "s1", createdAt: 1000 },
      "agent:agent-1:user-uid-456": { sessionId: "s2", createdAt: 2000 },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(sessions));

    migrateSessionKeys("/data/openclaw");

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toEqual({
      "agent:agent-1:direct:uid-123": { sessionId: "s1", createdAt: 1000 },
      "agent:agent-1:direct:uid-456": { sessionId: "s2", createdAt: 2000 },
    });
  });

  it("should preserve non-user keys unchanged", () => {
    mockedReaddirSync.mockReturnValue(["agent-1"] as unknown as ReturnType<typeof readdirSync>);
    const sessions = {
      "agent:agent-1:user-uid-123": { sessionId: "s1", createdAt: 1000 },
      "agent:agent-1:cron-job-1": { sessionId: "s3", createdAt: 3000 },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(sessions));

    migrateSessionKeys("/data/openclaw");

    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written["agent:agent-1:cron-job-1"]).toEqual({ sessionId: "s3", createdAt: 3000 });
    expect(written["agent:agent-1:direct:uid-123"]).toEqual({ sessionId: "s1", createdAt: 1000 });
  });

  it("should be idempotent - skip already migrated keys", () => {
    mockedReaddirSync.mockReturnValue(["agent-1"] as unknown as ReturnType<typeof readdirSync>);
    const sessions = {
      "agent:agent-1:direct:uid-123": { sessionId: "s1", createdAt: 1000 },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(sessions));

    migrateSessionKeys("/data/openclaw");

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("should handle missing agents directory gracefully", () => {
    mockedExistsSync.mockReturnValue(false);

    expect(() => migrateSessionKeys("/data/openclaw")).not.toThrow();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("should handle missing sessions.json gracefully", () => {
    mockedReaddirSync.mockReturnValue(["agent-1"] as unknown as ReturnType<typeof readdirSync>);
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes("sessions.json")) return false;
      return true;
    });

    expect(() => migrateSessionKeys("/data/openclaw")).not.toThrow();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("should process multiple agent directories", () => {
    mockedReaddirSync.mockReturnValue(["agent-1", "agent-2"] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).includes("agent-1")) {
        return JSON.stringify({ "agent:agent-1:user-uid-1": { sessionId: "s1" } });
      }
      return JSON.stringify({ "agent:agent-2:user-uid-2": { sessionId: "s2" } });
    });

    migrateSessionKeys("/data/openclaw");

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(2);
  });
});
