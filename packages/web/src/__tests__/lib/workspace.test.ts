import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const mkdirSyncMock = vi.fn();
  const statSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      statSync: statSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    statSync: statSyncMock,
  };
});

import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "fs";
import type { WorkspaceFile } from "@/lib/workspace";
import {
  ALLOWED_FILES,
  getWorkspacePath,
  getOpenClawWorkspacePath,
  ensureWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  generateIdentityContent,
  writeIdentityFile,
  getAgentBootstrapSizes,
} from "@/lib/workspace";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedStatSync = vi.mocked(statSync);

describe("ALLOWED_FILES", () => {
  it("should contain SOUL.md and AGENTS.md (not USER.md)", () => {
    expect(ALLOWED_FILES).toEqual(["SOUL.md", "AGENTS.md"]);
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

  it("should not create USER.md placeholder", () => {
    ensureWorkspace("agent-123");

    const userCall = mockedWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].endsWith("USER.md")
    );
    expect(userCall).toBeUndefined();
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

  it("creates an uploads/ subdir alongside the workspace root", () => {
    // Regression: fresh workspaces had no uploads/ dir until the chat UI
    // attached its first file, which broke any tool whose write_paths or
    // allowed_paths pointed at uploads/ (#418).
    ensureWorkspace("agent-123");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-123/uploads", {
      recursive: true,
    });
  });

  it("creates a workbench/ subdir for agent writes (pinchy_write target)", () => {
    // workbench/ is the agent's writable area, distinct from uploads/
    // (which is the user's). The dir must exist on workspace spawn
    // so pinchy_write to workbench/<file> on a fresh agent does not
    // ENOENT (#418).
    ensureWorkspace("agent-123");

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/workbench",
      { recursive: true }
    );
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

  it("should throw on USER.md (no longer in ALLOWED_FILES)", () => {
    expect(() => readWorkspaceFile("agent-123", "USER.md")).toThrow("File not allowed: USER.md");
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

  it("should throw on USER.md (no longer in ALLOWED_FILES)", () => {
    expect(() => writeWorkspaceFile("agent-123", "USER.md", "content")).toThrow(
      "File not allowed: USER.md"
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

describe("writeWorkspaceFileInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("should write USER.md bypassing ALLOWED_FILES check", () => {
    writeWorkspaceFileInternal("agent-123", "USER.md", "org context content");

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/openclaw-config/workspaces/agent-123/USER.md",
      "org context content",
      "utf-8"
    );
  });

  it("should create directory if it does not exist", () => {
    writeWorkspaceFileInternal("agent-456", "USER.md", "content");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-456", {
      recursive: true,
    });
  });

  it("should not create directory if it already exists", () => {
    mockedExistsSync.mockReturnValue(true);

    writeWorkspaceFileInternal("agent-456", "USER.md", "content");

    expect(mockedMkdirSync).not.toHaveBeenCalled();
  });

  it("should reject invalid agentId with path traversal", () => {
    expect(() => writeWorkspaceFileInternal("../evil", "USER.md", "content")).toThrow(
      "Invalid agentId: ../evil"
    );
  });

  it("should reject empty agentId", () => {
    expect(() => writeWorkspaceFileInternal("", "USER.md", "content")).toThrow("Invalid agentId: ");
  });
});

// Issue #373: sizing the agent's on-disk bootstrap files so build.ts can emit
// per-agent bootstrapMaxChars and avoid OpenClaw truncating injected instructions.
describe("getAgentBootstrapSizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Wire existsSync/statSync/readFileSync from a {filename: content} map.
  // statSync reports the UTF-8 byte length; readFileSync returns the content.
  function mockFiles(files: Record<string, string>) {
    const lookup = (p: unknown) =>
      Object.entries(files).find(([name]) => String(p).endsWith(`/${name}`));
    mockedExistsSync.mockImplementation((p) => lookup(p) !== undefined);
    mockedStatSync.mockImplementation((p) => {
      const match = lookup(p);
      if (!match) throw new Error("ENOENT");
      return { size: Buffer.byteLength(match[1], "utf-8") } as ReturnType<typeof statSync>;
    });
    mockedReadFileSync.mockImplementation((p) => {
      const match = lookup(p);
      return match ? match[1] : "";
    });
  }

  it("contributes the byte size of small bootstrap files without reading their content", () => {
    mockFiles({ "AGENTS.md": "a".repeat(5_000), "SOUL.md": "soul body" });

    const sizes = getAgentBootstrapSizes("agent-1");

    // Small files (<= the default cap) provably fit, so we use the cheap byte
    // size and never read the file content.
    expect(sizes).toContain(5_000);
    expect(sizes).toContain(Buffer.byteLength("soul body", "utf-8"));
    expect(sizes).toHaveLength(2);
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it("reads content for a file over the default cap and returns its trimmed char length", () => {
    mockFiles({ "AGENTS.md": "a".repeat(20_000) + "\n\n  " });

    const sizes = getAgentBootstrapSizes("agent-2");

    // Over the default cap → exact trimmed char length (drives the ceiling /
    // oversized decision accurately, even for multibyte instructions).
    expect(sizes).toEqual([20_000]);
    expect(mockedReadFileSync).toHaveBeenCalled();
  });

  it("skips bootstrap files that do not exist", () => {
    mockFiles({ "AGENTS.md": "instructions" });

    const sizes = getAgentBootstrapSizes("agent-3");

    expect(sizes).toEqual([Buffer.byteLength("instructions", "utf-8")]);
  });

  it("returns an empty array when no bootstrap files exist", () => {
    mockedExistsSync.mockReturnValue(false);

    expect(getAgentBootstrapSizes("agent-4")).toEqual([]);
  });

  it("skips zero-byte and un-stattable files", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockImplementation((p) => {
      if (String(p).endsWith("/AGENTS.md")) return { size: 0 } as ReturnType<typeof statSync>;
      throw new Error("EACCES");
    });

    expect(getAgentBootstrapSizes("agent-5")).toEqual([]);
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the byte size when a large file cannot be read as a string", () => {
    mockedExistsSync.mockImplementation((p) => String(p).endsWith("/AGENTS.md"));
    mockedStatSync.mockImplementation(() => ({ size: 20_000 }) as ReturnType<typeof statSync>);
    mockedReadFileSync.mockReturnValue(undefined as unknown as string);

    expect(getAgentBootstrapSizes("agent-6")).toEqual([20_000]);
  });

  it("rejects invalid agentId with path traversal", () => {
    expect(() => getAgentBootstrapSizes("../evil")).toThrow("Invalid agentId: ../evil");
  });
});
