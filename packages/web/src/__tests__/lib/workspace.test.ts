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
import type { WorkspaceFile } from "@/lib/workspace";
import {
  ALLOWED_FILES,
  getWorkspacePath,
  getOpenClawWorkspacePath,
  ensureWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  generateIdentityContent,
  writeIdentityFile,
} from "@/lib/workspace";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe("ALLOWED_FILES", () => {
  it("should contain SOUL.md, USER.md, and AGENTS.md", () => {
    expect(ALLOWED_FILES).toEqual(["SOUL.md", "USER.md", "AGENTS.md"]);
  });

  it("should be a readonly array", () => {
    expect(Array.isArray(ALLOWED_FILES)).toBe(true);
  });
});

describe("WorkspaceFile type", () => {
  it("should be assignable from ALLOWED_FILES entries", () => {
    const file: WorkspaceFile = ALLOWED_FILES[0];
    expect(file).toBe("SOUL.md");
  });
});

describe("agentId validation", () => {
  it("should reject agentId containing forward slash", () => {
    expect(() => getWorkspacePath("../../etc/cron.d")).toThrow("Invalid agentId: ../../etc/cron.d");
  });

  it("should reject agentId containing backslash", () => {
    expect(() => getWorkspacePath("..\\etc\\passwd")).toThrow("Invalid agentId: ..\\etc\\passwd");
  });

  it("should reject agentId containing ..", () => {
    expect(() => getWorkspacePath("..")).toThrow("Invalid agentId: ..");
  });

  it("should reject empty agentId", () => {
    expect(() => getWorkspacePath("")).toThrow("Invalid agentId: ");
  });

  it("should reject path traversal in ensureWorkspace", () => {
    expect(() => ensureWorkspace("../evil")).toThrow("Invalid agentId: ../evil");
  });

  it("should reject path traversal in readWorkspaceFile", () => {
    expect(() => readWorkspaceFile("../../etc", "SOUL.md")).toThrow("Invalid agentId: ../../etc");
  });

  it("should reject path traversal in writeWorkspaceFile", () => {
    expect(() => writeWorkspaceFile("../hack", "SOUL.md", "content")).toThrow(
      "Invalid agentId: ../hack"
    );
  });

  it("should accept valid agentId", () => {
    const path = getWorkspacePath("agent-123");
    expect(path).toBe("/openclaw-config/workspaces/agent-123");
  });

  it("should accept agentId with UUID format", () => {
    const path = getWorkspacePath("550e8400-e29b-41d4-a716-446655440000");
    expect(path).toBe("/openclaw-config/workspaces/550e8400-e29b-41d4-a716-446655440000");
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

describe("getOpenClawWorkspacePath", () => {
  it("should return OpenClaw workspace path for agent", () => {
    const path = getOpenClawWorkspacePath("550e8400-e29b-41d4-a716-446655440000");
    expect(path).toBe("/root/.openclaw/workspaces/550e8400-e29b-41d4-a716-446655440000");
  });

  it("should use OPENCLAW_WORKSPACE_PREFIX env var when set", () => {
    const originalEnv = process.env.OPENCLAW_WORKSPACE_PREFIX;
    process.env.OPENCLAW_WORKSPACE_PREFIX = "/custom/openclaw/workspaces";

    const path = getOpenClawWorkspacePath("agent-456");
    expect(path).toBe("/custom/openclaw/workspaces/agent-456");

    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_WORKSPACE_PREFIX;
    } else {
      process.env.OPENCLAW_WORKSPACE_PREFIX = originalEnv;
    }
  });

  it("should reject invalid agentId", () => {
    expect(() => getOpenClawWorkspacePath("../evil")).toThrow("Invalid agentId: ../evil");
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

  it("should create AGENTS.md with placeholder content when missing", () => {
    ensureWorkspace("agent-123");

    const agentsCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md")
    );
    expect(agentsCall).toBeDefined();
    expect(agentsCall![0]).toBe("/openclaw-config/workspaces/agent-123/AGENTS.md");
    expect(agentsCall![1]).toContain("Define your agent's instructions here");
  });

  it("should not overwrite existing AGENTS.md", () => {
    mockedExistsSync.mockImplementation((p) => {
      return typeof p === "string" && p.endsWith("AGENTS.md");
    });

    ensureWorkspace("agent-123");

    const agentsCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md")
    );
    expect(agentsCall).toBeUndefined();
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

  it("should read AGENTS.md content", () => {
    mockedReadFileSync.mockReturnValue("Answer questions about HR policies.");

    const content = readWorkspaceFile("agent-123", "AGENTS.md");

    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/AGENTS.md",
      "utf-8"
    );
    expect(content).toBe("Answer questions about HR policies.");
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

  it("should write content to AGENTS.md", () => {
    writeWorkspaceFile("agent-123", "AGENTS.md", "Answer questions about HR policies.");

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/AGENTS.md",
      "Answer questions about HR policies.",
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

describe("generateIdentityContent", () => {
  it("should return markdown with name heading and tagline", () => {
    const result = generateIdentityContent({
      name: "Smithers",
      tagline: "Your reliable personal assistant",
    });
    expect(result).toBe("# Smithers\n> Your reliable personal assistant");
  });

  it("should return only name heading when tagline is null", () => {
    const result = generateIdentityContent({ name: "Custom Agent", tagline: null });
    expect(result).toBe("# Custom Agent");
  });
});

describe("writeIdentityFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("should write IDENTITY.md to workspace directory", () => {
    writeIdentityFile("agent-123", {
      name: "Smithers",
      tagline: "Your reliable personal assistant",
    });

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/IDENTITY.md",
      "# Smithers\n> Your reliable personal assistant",
      "utf-8"
    );
  });

  it("should write only name heading when tagline is null", () => {
    writeIdentityFile("agent-123", { name: "Custom Agent", tagline: null });

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/IDENTITY.md",
      "# Custom Agent",
      "utf-8"
    );
  });

  it("should create workspace directory if needed", () => {
    writeIdentityFile("agent-456", { name: "Test", tagline: null });

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-456", {
      recursive: true,
    });
  });

  it("should not create directory if it already exists", () => {
    mockedExistsSync.mockReturnValue(true);

    writeIdentityFile("agent-456", { name: "Test", tagline: null });

    expect(mockedMkdirSync).not.toHaveBeenCalled();
  });

  it("should reject invalid agentId", () => {
    expect(() => writeIdentityFile("../evil", { name: "Evil", tagline: null })).toThrow(
      "Invalid agentId: ../evil"
    );
  });

  it("should not be accessible via readWorkspaceFile", () => {
    expect(() => readWorkspaceFile("agent-123", "IDENTITY.md")).toThrow(
      "File not allowed: IDENTITY.md"
    );
  });

  it("should not be accessible via writeWorkspaceFile", () => {
    expect(() => writeWorkspaceFile("agent-123", "IDENTITY.md", "content")).toThrow(
      "File not allowed: IDENTITY.md"
    );
  });
});
