import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn();
  return {
    ...actual,
    default: { ...actual, readFileSync: readFileSyncMock, existsSync: existsSyncMock },
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
  };
});

import { readFileSync, existsSync } from "fs";
import { resolvePairingCode } from "@/lib/telegram-pairing";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);

describe("resolvePairingCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns telegram user ID for valid pairing code", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        requests: [{ id: "8754697762", code: "FMSVEN7M", createdAt: new Date().toISOString() }],
      })
    );

    const result = resolvePairingCode("FMSVEN7M");
    expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
  });

  it("matches code case-insensitively", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        requests: [{ id: "12345", code: "ABC123", createdAt: new Date().toISOString() }],
      })
    );

    const result = resolvePairingCode("abc123");
    expect(result).toEqual({ found: true, telegramUserId: "12345" });
  });

  it("returns not found for unknown code", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        requests: [{ id: "12345", code: "ABC123", createdAt: new Date().toISOString() }],
      })
    );

    const result = resolvePairingCode("WRONG");
    expect(result).toEqual({ found: false });
  });

  it("returns not found when pairing file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = resolvePairingCode("ABC123");
    expect(result).toEqual({ found: false });
  });

  it("returns not found when pairing file is empty", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ version: 1, requests: [] }));

    const result = resolvePairingCode("ABC123");
    expect(result).toEqual({ found: false });
  });
});
