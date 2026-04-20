import { describe, expect, it } from "vitest";

import {
  detectPipedriveAccessLevel,
  getPipedriveTools,
  getPipedriveToolsForAccessLevel,
  type PipedriveAccessLevel,
} from "../tool-registry";

describe("Pipedrive tool registry", () => {
  describe("getPipedriveTools", () => {
    it("returns all 10 Pipedrive tool definitions", () => {
      const tools = getPipedriveTools();
      expect(tools).toHaveLength(10);
      expect(tools.every((t) => t.integration === "pipedrive")).toBe(true);
    });

    it("includes both safe and powerful tools", () => {
      const tools = getPipedriveTools();
      const safe = tools.filter((t) => t.category === "safe");
      const powerful = tools.filter((t) => t.category === "powerful");
      expect(safe).toHaveLength(4);
      expect(powerful).toHaveLength(6);
    });
  });

  describe("getPipedriveToolsForAccessLevel", () => {
    it("read-only returns 4 read tools", () => {
      const tools = getPipedriveToolsForAccessLevel("read-only");
      expect(tools).toHaveLength(4);
      expect(tools).toEqual([
        "pipedrive_schema",
        "pipedrive_read",
        "pipedrive_search",
        "pipedrive_summary",
      ]);
    });

    it("read-write returns 8 tools (read + write, no delete/merge)", () => {
      const tools = getPipedriveToolsForAccessLevel("read-write");
      expect(tools).toHaveLength(8);
      expect(tools).toContain("pipedrive_schema");
      expect(tools).toContain("pipedrive_read");
      expect(tools).toContain("pipedrive_create");
      expect(tools).toContain("pipedrive_update");
      expect(tools).toContain("pipedrive_relate");
      expect(tools).toContain("pipedrive_convert");
      expect(tools).not.toContain("pipedrive_delete");
      expect(tools).not.toContain("pipedrive_merge");
    });

    it("full returns all 10 tools", () => {
      const tools = getPipedriveToolsForAccessLevel("full");
      expect(tools).toHaveLength(10);
      expect(tools).toContain("pipedrive_delete");
      expect(tools).toContain("pipedrive_merge");
    });

    it("custom returns only pipedrive_schema", () => {
      const tools = getPipedriveToolsForAccessLevel("custom");
      expect(tools).toEqual(["pipedrive_schema"]);
    });
  });

  describe("detectPipedriveAccessLevel", () => {
    it("detects read-only from matching tool set", () => {
      const level = detectPipedriveAccessLevel([
        "pipedrive_schema",
        "pipedrive_read",
        "pipedrive_search",
        "pipedrive_summary",
      ]);
      expect(level).toBe("read-only");
    });

    it("detects read-write from matching tool set", () => {
      const level = detectPipedriveAccessLevel(getPipedriveToolsForAccessLevel("read-write"));
      expect(level).toBe("read-write");
    });

    it("detects full from matching tool set", () => {
      const level = detectPipedriveAccessLevel(getPipedriveToolsForAccessLevel("full"));
      expect(level).toBe("full");
    });

    it("returns custom for partial sets", () => {
      const level = detectPipedriveAccessLevel(["pipedrive_schema", "pipedrive_create"]);
      expect(level).toBe("custom");
    });

    it("returns custom when no pipedrive tools are present", () => {
      const level = detectPipedriveAccessLevel(["odoo_schema", "pinchy_ls"]);
      expect(level).toBe("custom");
    });

    it("ignores non-pipedrive tools in the input", () => {
      const level = detectPipedriveAccessLevel([
        "odoo_schema",
        "pipedrive_schema",
        "pipedrive_read",
        "pipedrive_search",
        "pipedrive_summary",
      ]);
      expect(level).toBe("read-only");
    });

    it("round-trips through all preset levels", () => {
      const levels: PipedriveAccessLevel[] = ["read-only", "read-write", "full"];
      for (const level of levels) {
        const tools = getPipedriveToolsForAccessLevel(level);
        expect(detectPipedriveAccessLevel(tools)).toBe(level);
      }
    });
  });
});
