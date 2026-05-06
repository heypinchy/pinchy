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

  it("regression: logs a warning when the pairing file is unreadable (EACCES)", () => {
    // On v0.5.0 staging, OpenClaw writes telegram-pairing.json as root:0600.
    // Pinchy (uid 999) gets EACCES when reading it, but the resolver's bare
    // catch{} swallowed the error and returned { found: false }, surfacing
    // to the user as a misleading "Invalid or expired pairing code".
    // The fix is operational (start-openclaw.sh chmods the file), but the
    // resolver MUST log non-ENOENT errors so future regressions of this
    // class are immediately visible in container logs instead of debugging
    // for an hour.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      const err = new Error(
        "EACCES: permission denied, open '/openclaw-config/credentials/telegram-pairing.json'"
      ) as Error & { code: string };
      err.code = "EACCES";
      throw err;
    });

    const result = resolvePairingCode("VVN2THRM");
    expect(result).toEqual({ found: false });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[telegram-pairing]"),
      expect.stringContaining("EACCES")
    );
    warnSpy.mockRestore();
  });

  it("does NOT log when the pairing file simply does not exist (ENOENT is normal)", () => {
    // existsSync handles the ENOENT-by-stat case; this guards against a
    // future change that drops the existsSync check and starts logging on
    // every cold start (where the file legitimately doesn't exist yet).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(false);

    const result = resolvePairingCode("VVN2THRM");
    expect(result).toEqual({ found: false });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("regression: matches the exact staging pairing-file shape (with lastSeenAt + meta)", () => {
    // Reproduces the staging payload Pinchy's own /api/settings/telegram POST
    // received on 2026-04-29 — verbatim file content from
    // /openclaw-config/credentials/telegram-pairing.json. The user submitted
    // the matching code via the UI and got "Invalid or expired pairing code".
    // If this test passes locally, the bug is environmental (path, race,
    // mtime), not in the resolver's matching logic.
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: "8754697762",
            code: "VVN2THRM",
            createdAt: "2026-04-29T16:52:07.768Z",
            lastSeenAt: "2026-04-29T16:56:04.803Z",
            meta: {
              username: "clemenshelm",
              firstName: "Clemens",
              lastName: "Helm",
              accountId: "ffa4180a-b920-42f0-9ee1-c61250e952ed",
            },
          },
        ],
      })
    );

    const result = resolvePairingCode("VVN2THRM");
    expect(result).toEqual({ found: true, telegramUserId: "8754697762" });
  });
});
