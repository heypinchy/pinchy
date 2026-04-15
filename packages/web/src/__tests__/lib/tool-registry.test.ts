import { describe, it, expect } from "vitest";
import {
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  computeDeniedGroups,
  getOdooTools,
  getOdooToolsForAccessLevel,
  detectOdooAccessLevel,
} from "@/lib/tool-registry";

describe("TOOL_REGISTRY", () => {
  it("contains safe tools", () => {
    const safe = TOOL_REGISTRY.filter((t) => t.category === "safe");
    expect(safe.length).toBeGreaterThanOrEqual(2);
    expect(safe.map((t) => t.id)).toContain("pinchy_ls");
    expect(safe.map((t) => t.id)).toContain("pinchy_read");
  });

  it("does not expose docs_list / docs_read as admin-configurable tools", () => {
    // The pinchy-docs plugin is enabled automatically for every personal
    // agent (Smithers) via openclaw-config.ts — it is NOT steered by an
    // agent's allowedTools. Surfacing these tools in the per-agent permission
    // UI would imply admins can grant them to any agent, but the checkbox has
    // no effect on non-personal agents. Keep them out of the registry so the
    // UI doesn't lie about what can be controlled.
    const ids = TOOL_REGISTRY.map((t) => t.id);
    expect(ids).not.toContain("docs_list");
    expect(ids).not.toContain("docs_read");
    expect(getToolById("docs_list")).toBeUndefined();
    expect(getToolById("docs_read")).toBeUndefined();
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

describe("Odoo access level helpers", () => {
  it("all odoo tools have integration: 'odoo'", () => {
    const odooTools = TOOL_REGISTRY.filter((t) => t.id.startsWith("odoo_"));
    expect(odooTools.length).toBe(7);
    for (const tool of odooTools) {
      expect(tool.integration).toBe("odoo");
    }
  });

  it("non-odoo tools don't have integration set", () => {
    const nonOdooTools = TOOL_REGISTRY.filter((t) => !t.id.startsWith("odoo_"));
    for (const tool of nonOdooTools) {
      expect(tool.integration).toBeUndefined();
    }
  });

  it("getOdooToolsForAccessLevel('read-only') returns exactly the 4 read tools", () => {
    const tools = getOdooToolsForAccessLevel("read-only");
    expect(tools).toEqual(["odoo_schema", "odoo_read", "odoo_count", "odoo_aggregate"]);
  });

  it("getOdooToolsForAccessLevel('read-write') returns 6 tools", () => {
    const tools = getOdooToolsForAccessLevel("read-write");
    expect(tools).toEqual([
      "odoo_schema",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_write",
    ]);
  });

  it("getOdooToolsForAccessLevel('full') returns all 7 tools", () => {
    const tools = getOdooToolsForAccessLevel("full");
    expect(tools).toEqual([
      "odoo_schema",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_write",
      "odoo_delete",
    ]);
  });

  it("getOdooToolsForAccessLevel('custom') returns only schema", () => {
    const tools = getOdooToolsForAccessLevel("custom");
    expect(tools).toEqual(["odoo_schema"]);
  });

  it("getOdooTools() returns exactly 7 tools", () => {
    const tools = getOdooTools();
    expect(tools).toHaveLength(7);
    expect(tools.every((t) => t.integration === "odoo")).toBe(true);
  });

  it("detectOdooAccessLevel correctly identifies read-only preset", () => {
    expect(
      detectOdooAccessLevel(["odoo_schema", "odoo_read", "odoo_count", "odoo_aggregate"])
    ).toBe("read-only");
  });

  it("detectOdooAccessLevel correctly identifies read-write preset", () => {
    expect(
      detectOdooAccessLevel([
        "odoo_schema",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
        "odoo_create",
        "odoo_write",
      ])
    ).toBe("read-write");
  });

  it("detectOdooAccessLevel correctly identifies full preset", () => {
    expect(
      detectOdooAccessLevel([
        "odoo_schema",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
        "odoo_create",
        "odoo_write",
        "odoo_delete",
      ])
    ).toBe("full");
  });

  it("detectOdooAccessLevel returns 'custom' for non-preset combinations", () => {
    // Only schema + delete — not a standard preset
    expect(detectOdooAccessLevel(["odoo_schema", "odoo_delete"])).toBe("custom");
  });

  it("detectOdooAccessLevel returns 'custom' when no odoo tools present", () => {
    expect(detectOdooAccessLevel(["pinchy_ls", "pinchy_read"])).toBe("custom");
  });
});
