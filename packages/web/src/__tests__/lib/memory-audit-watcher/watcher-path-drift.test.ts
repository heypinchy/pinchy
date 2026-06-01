import { describe, it, expect } from "vitest";
import { parseAgentMemoryPath } from "@/lib/memory-audit-watcher/parse-path";
import { getWorkspaceBasePath, getWorkspacePath } from "@/lib/workspace";

// Drift guard for issue #345.
//
// The memory-audit watcher and the workspace-path code MUST agree on where an
// agent's files live on disk. #345 shipped a watcher that hardcoded
// `agents/<id>/` while real Pinchy agents live under `workspaces/<id>/`, so the
// watcher silently watched the wrong subtree and never fired in production.
//
// This test pins the two together: it takes the canonical path that
// `getWorkspacePath()` produces (the SAME helper build.ts / ensureWorkspace use
// to place real agent files) and feeds it through the watcher's parser with
// `getWorkspaceBasePath()` as the root (the SAME base the bootstrap passes to
// the watcher). If anyone changes the on-disk layout in workspace.ts without
// updating parse-path.ts (or vice versa), this round-trip breaks — which is
// exactly the drift that produced the dead-code watcher.
describe("watcher ⇄ workspace path drift guard (#345)", () => {
  const agentId = "test-id";
  const base = getWorkspaceBasePath();

  it("round-trips MEMORY.md at the workspace root", () => {
    const memoryPath = `${getWorkspacePath(agentId)}/MEMORY.md`;
    expect(parseAgentMemoryPath(base, memoryPath)).toEqual({
      agentId,
      file: "MEMORY.md",
    });
  });

  it("round-trips a daily note under memory/", () => {
    const dailyPath = `${getWorkspacePath(agentId)}/memory/2026-06-01.md`;
    expect(parseAgentMemoryPath(base, dailyPath)).toEqual({
      agentId,
      file: "memory/2026-06-01.md",
    });
  });

  it("does NOT match instruction files (SOUL.md / AGENTS.md stay un-audited)", () => {
    expect(parseAgentMemoryPath(base, `${getWorkspacePath(agentId)}/SOUL.md`)).toBeNull();
    expect(parseAgentMemoryPath(base, `${getWorkspacePath(agentId)}/AGENTS.md`)).toBeNull();
  });
});
