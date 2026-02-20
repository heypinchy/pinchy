import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const mkdirSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import {
  ALLOWED_FILES,
  getWorkspacePath,
  ensureWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe("ALLOWED_FILES", () => {
  it("should contain SOUL.md and USER.md", () => {
    expect(ALLOWED_FILES).toEqual(["SOUL.md", "USER.md"]);
  });

  it("should be a readonly array", () => {
    expect(Array.isArray(ALLOWED_FILES)).toBe(true);
  });
});

describe("getWorkspacePath", () => {
  it("should return path under default workspace base directory", () => {
    const path = getWorkspacePath("agent-123");
    expect(path).toBe("/openclaw-config/workspaces/agent-123");
  });

  it("should use WORKSPACE_BASE_PATH env var when set", () => {
    const originalEnv = process.env.WORKSPACE_BASE_PATH;
    process.env.WORKSPACE_BASE_PATH = "/custom/path";

    const path = getWorkspacePath("agent-456");
    expect(path).toBe("/custom/path/agent-456");

    if (originalEnv === undefined) {
      delete process.env.WORKSPACE_BASE_PATH;
    } else {
      process.env.WORKSPACE_BASE_PATH = originalEnv;
    }
  });
});

describe("ensureWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("should create workspace directory if it does not exist", () => {
    ensureWorkspace("agent-123");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-123", {
      recursive: true,
    });
  });

  it("should create SOUL.md with placeholder content when missing", () => {
    ensureWorkspace("agent-123");

    const soulCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("SOUL.md")
    );
    expect(soulCall).toBeDefined();
    expect(soulCall![0]).toBe("/openclaw-config/workspaces/agent-123/SOUL.md");
    expect(soulCall![1]).toContain("Describe your agent's personality here");
  });

  it("should create USER.md with placeholder content when missing", () => {
    ensureWorkspace("agent-123");

    const userCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("USER.md")
    );
    expect(userCall).toBeDefined();
    expect(userCall![0]).toBe("/openclaw-config/workspaces/agent-123/USER.md");
    expect(userCall![1]).toContain("Add context about your team or organization here");
  });

  it("should not overwrite existing SOUL.md", () => {
    mockedExistsSync.mockImplementation((p) => {
      return typeof p === "string" && p.endsWith("SOUL.md");
    });

    ensureWorkspace("agent-123");

    const soulCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("SOUL.md")
    );
    expect(soulCall).toBeUndefined();
  });

  it("should not overwrite existing USER.md", () => {
    mockedExistsSync.mockImplementation((p) => {
      return typeof p === "string" && p.endsWith("USER.md");
    });

    ensureWorkspace("agent-123");

    const userCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("USER.md")
    );
    expect(userCall).toBeUndefined();
  });
});

describe("readWorkspaceFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should read SOUL.md content", () => {
    mockedReadFileSync.mockReturnValue("You are a helpful assistant.");

    const content = readWorkspaceFile("agent-123", "SOUL.md");

    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/SOUL.md",
      "utf-8"
    );
    expect(content).toBe("You are a helpful assistant.");
  });

  it("should read USER.md content", () => {
    mockedReadFileSync.mockReturnValue("We are a startup.");

    const content = readWorkspaceFile("agent-123", "USER.md");

    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/USER.md",
      "utf-8"
    );
    expect(content).toBe("We are a startup.");
  });

  it("should return empty string if file does not exist", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const content = readWorkspaceFile("agent-123", "SOUL.md");
    expect(content).toBe("");
  });

  it("should throw on disallowed filename", () => {
    expect(() => readWorkspaceFile("agent-123", "SECRET.md")).toThrow(
      "File not allowed: SECRET.md"
    );
  });

  it("should throw on path traversal attempt with ../", () => {
    expect(() => readWorkspaceFile("agent-123", "../etc/passwd")).toThrow(
      "File not allowed: ../etc/passwd"
    );
  });

  it("should throw on path traversal attempt with subdirectory", () => {
    expect(() => readWorkspaceFile("agent-123", "subdir/SOUL.md")).toThrow(
      "File not allowed: subdir/SOUL.md"
    );
  });

  it("should throw on empty filename", () => {
    expect(() => readWorkspaceFile("agent-123", "")).toThrow("File not allowed: ");
  });
});

describe("writeWorkspaceFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("should write content to SOUL.md", () => {
    writeWorkspaceFile("agent-123", "SOUL.md", "You are a project manager.");

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/SOUL.md",
      "You are a project manager.",
      "utf-8"
    );
  });

  it("should write content to USER.md", () => {
    writeWorkspaceFile("agent-123", "USER.md", "We build e-commerce software.");

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/USER.md",
      "We build e-commerce software.",
      "utf-8"
    );
  });

  it("should create directory if it does not exist", () => {
    writeWorkspaceFile("agent-456", "SOUL.md", "Content");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-456", {
      recursive: true,
    });
  });

  it("should not create directory if it already exists", () => {
    mockedExistsSync.mockReturnValue(true);

    writeWorkspaceFile("agent-456", "SOUL.md", "Content");

    expect(mockedMkdirSync).not.toHaveBeenCalled();
  });

  it("should throw on disallowed filename", () => {
    expect(() => writeWorkspaceFile("agent-123", "HACK.md", "malicious")).toThrow(
      "File not allowed: HACK.md"
    );
  });

  it("should throw on path traversal attempt", () => {
    expect(() => writeWorkspaceFile("agent-123", "../../etc/passwd", "pwned")).toThrow(
      "File not allowed: ../../etc/passwd"
    );
  });

  it("should throw on filename with directory separator", () => {
    expect(() => writeWorkspaceFile("agent-123", "foo/SOUL.md", "content")).toThrow(
      "File not allowed: foo/SOUL.md"
    );
  });

  it("should not write file when filename is disallowed", () => {
    try {
      writeWorkspaceFile("agent-123", "EVIL.md", "content");
    } catch {
      // expected
    }

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});
