import { describe, it, expect } from "vitest";
import { parseAgentMemoryPath } from "@/lib/memory-audit-watcher/parse-path";

// Pinchy agents live under `<workspaceBase>/<agentId>/` (see workspace.ts), so
// a memory file is `<root>/<agentId>/MEMORY.md` — NOT `<root>/agents/<id>/…`.
// The watcher watches the workspace base directly; the agentId is the first
// path segment under the root.
describe("parseAgentMemoryPath", () => {
  const root = "/openclaw-config/workspaces";

  it("parses MEMORY.md at the agent root", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc-123/MEMORY.md")).toEqual({
      agentId: "abc-123",
      file: "MEMORY.md",
    });
  });

  it("parses files under memory/", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc-123/memory/foo.md")).toEqual(
      {
        agentId: "abc-123",
        file: "memory/foo.md",
      }
    );
  });

  it("parses nested files under memory/", () => {
    expect(
      parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc-123/memory/sub/bar.md")
    ).toEqual({
      agentId: "abc-123",
      file: "memory/sub/bar.md",
    });
  });

  it("returns null for non-memory files at the agent root", () => {
    // Instruction files and other workspace files must never be audited as
    // memory writes.
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc/SOUL.md")).toBeNull();
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc/AGENTS.md")).toBeNull();
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc/notes/foo.md")).toBeNull();
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc/uploads/x.md")).toBeNull();
  });

  it("returns null for files directly under the root (no agent segment)", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/openclaw.json")).toBeNull();
  });

  it("rejects paths above the root", () => {
    expect(parseAgentMemoryPath(root, "/etc/passwd")).toBeNull();
  });

  it("rejects the agent directory itself (no file)", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc-123")).toBeNull();
  });

  it("rejects the memory/ directory itself (no file)", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/workspaces/abc-123/memory")).toBeNull();
  });
});
