import { describe, it, expect } from "vitest";
import {
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  computeDeniedGroups,
} from "@/lib/tool-registry";

describe("TOOL_REGISTRY", () => {
  it("contains safe tools", () => {
    const safe = TOOL_REGISTRY.filter((t) => t.category === "safe");
    expect(safe.length).toBeGreaterThanOrEqual(2);
    expect(safe.map((t) => t.id)).toContain("pinchy_ls");
    expect(safe.map((t) => t.id)).toContain("pinchy_read");
  });

  it("contains powerful tools", () => {
    const powerful = TOOL_REGISTRY.filter((t) => t.category === "powerful");
    expect(powerful.length).toBe(3);
    expect(powerful.map((t) => t.id)).toEqual(["odoo_create", "odoo_write", "odoo_delete"]);
  });

  it("does not contain any OpenClaw native tools", () => {
    const nativeTools = [
      "shell",
      "fs_read",
      "fs_write",
      "pdf",
      "image",
      "image_generate",
      "web_fetch",
      "web_search",
    ];
    const ids = TOOL_REGISTRY.map((t) => t.id);
    for (const native of nativeTools) {
      expect(ids).not.toContain(native);
    }
  });

  it("no tool has a group property", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool).not.toHaveProperty("group");
    }
  });

  it("every tool has id, label, description, and category", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.id).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(["safe", "powerful"]).toContain(tool.category);
    }
  });

  it("has unique tool IDs", () => {
    const ids = TOOL_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getToolById", () => {
  it("returns a tool by ID", () => {
    const tool = getToolById("pinchy_ls");
    expect(tool?.label).toBe("List approved directories");
  });

  it("returns undefined for unknown ID", () => {
    expect(getToolById("nonexistent")).toBeUndefined();
  });
});

describe("getToolsByCategory", () => {
  it("returns only safe tools", () => {
    const safe = getToolsByCategory("safe");
    expect(safe.every((t) => t.category === "safe")).toBe(true);
  });

  it("returns only powerful tools", () => {
    const powerful = getToolsByCategory("powerful");
    expect(powerful.every((t) => t.category === "powerful")).toBe(true);
  });
});

describe("computeDeniedGroups", () => {
  it("always returns all groups and standalone tools", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).toEqual([
      "group:runtime",
      "group:fs",
      "group:web",
      "pdf",
      "image",
      "image_generate",
    ]);
  });

  it("returns full deny list even when tool IDs are passed", () => {
    const denied = computeDeniedGroups(["pinchy_ls", "odoo_create"]);
    expect(denied).toEqual([
      "group:runtime",
      "group:fs",
      "group:web",
      "pdf",
      "image",
      "image_generate",
    ]);
  });
});
