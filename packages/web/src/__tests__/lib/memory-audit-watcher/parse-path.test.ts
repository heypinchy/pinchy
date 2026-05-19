import { describe, it, expect } from "vitest";
import { parseAgentMemoryPath } from "@/lib/memory-audit-watcher/parse-path";

describe("parseAgentMemoryPath", () => {
  const root = "/openclaw-config";

  it("parses MEMORY.md at the agent root", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc-123/MEMORY.md")).toEqual({
      agentId: "abc-123",
      file: "MEMORY.md",
    });
  });

  it("parses files under memory/", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc-123/memory/foo.md")).toEqual({
      agentId: "abc-123",
      file: "memory/foo.md",
    });
  });

  it("parses nested files under memory/", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc-123/memory/sub/bar.md")).toEqual(
      {
        agentId: "abc-123",
        file: "memory/sub/bar.md",
      }
    );
  });

  it("returns null for paths outside agents/", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/openclaw.json")).toBeNull();
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc/other.md")).toBeNull();
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc/notes/foo.md")).toBeNull();
  });

  it("rejects paths above the root", () => {
    expect(parseAgentMemoryPath(root, "/etc/passwd")).toBeNull();
  });

  it("rejects directories that look like agents/<id> but lack the file", () => {
    expect(parseAgentMemoryPath(root, "/openclaw-config/agents/abc-123")).toBeNull();
  });
});
