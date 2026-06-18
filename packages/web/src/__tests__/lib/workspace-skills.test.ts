import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const mkdirSyncMock = vi.fn();
  const rmSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      rmSync: rmSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
  };
});

import { writeFileSync, mkdirSync, rmSync } from "fs";
import { writeWorkspaceSkill, removeWorkspaceSkill, getWorkspaceSkillPath } from "@/lib/workspace";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedRmSync = vi.mocked(rmSync);

describe("workspace skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getWorkspaceSkillPath", () => {
    it("returns <workspaceBase>/<agentId>/skills/<skillId>/SKILL.md", () => {
      const path = getWorkspaceSkillPath("agent-uuid-1", "web-search");
      // OpenClaw resolves <workspace>/skills/<id>/SKILL.md — must match
      // smoke-test path layout against OC 2026.6.5.
      expect(path).toMatch(/\/workspaces\/agent-uuid-1\/skills\/web-search\/SKILL\.md$/);
    });

    it("rejects an invalid agentId", () => {
      expect(() => getWorkspaceSkillPath("../escape", "web-search")).toThrow(/invalid agentid/i);
    });

    it("rejects an invalid skillId (path traversal)", () => {
      expect(() => getWorkspaceSkillPath("agent-1", "../escape")).toThrow(/invalid skill/i);
    });

    it("rejects a skillId with slashes", () => {
      expect(() => getWorkspaceSkillPath("agent-1", "foo/bar")).toThrow(/invalid skill/i);
    });

    it("rejects a skillId starting with a digit (AgentSkills.io convention)", () => {
      expect(() => getWorkspaceSkillPath("agent-1", "99-bottles")).toThrow(/invalid skill/i);
    });

    it("rejects a skillId with uppercase letters", () => {
      expect(() => getWorkspaceSkillPath("agent-1", "WebSearch")).toThrow(/invalid skill/i);
    });
  });

  describe("writeWorkspaceSkill", () => {
    it("creates the skills/<id> directory and writes SKILL.md with the given body", () => {
      writeWorkspaceSkill(
        "agent-1",
        "web-search",
        "---\nname: web-search\ndescription: foo\n---\n\nBody.\n"
      );

      // skills/<id> directory exists
      expect(mockedMkdirSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/workspaces\/agent-1\/skills\/web-search$/),
        { recursive: true }
      );
      // SKILL.md is written
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/workspaces\/agent-1\/skills\/web-search\/SKILL\.md$/),
        expect.stringContaining("name: web-search"),
        "utf-8"
      );
    });

    it("rejects writing to an invalid agentId", () => {
      expect(() => writeWorkspaceSkill("../escape", "web-search", "body")).toThrow(
        /invalid agentid/i
      );
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });

    it("rejects writing to an invalid skillId", () => {
      expect(() => writeWorkspaceSkill("agent-1", "../escape", "body")).toThrow(/invalid skill/i);
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("removeWorkspaceSkill", () => {
    it("removes the skills/<id> directory recursively", () => {
      removeWorkspaceSkill("agent-1", "web-search");
      expect(mockedRmSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/workspaces\/agent-1\/skills\/web-search$/),
        { recursive: true, force: true }
      );
    });

    it("rejects an invalid agentId", () => {
      expect(() => removeWorkspaceSkill("../escape", "web-search")).toThrow(/invalid agentid/i);
      expect(mockedRmSync).not.toHaveBeenCalled();
    });

    it("rejects an invalid skillId", () => {
      expect(() => removeWorkspaceSkill("agent-1", "../escape")).toThrow(/invalid skill/i);
      expect(mockedRmSync).not.toHaveBeenCalled();
    });
  });
});
