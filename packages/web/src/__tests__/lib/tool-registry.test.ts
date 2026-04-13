import { describe, it, expect } from "vitest";
import {
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  computeDeniedGroups,
  getOdooTools,
  getOdooToolsForAccessLevel,
  detectOdooAccessLevel,
  getEmailTools,
} from "@/lib/tool-registry";

describe("TOOL_REGISTRY", () => {
  it("contains safe tools", () => {
    const safe = TOOL_REGISTRY.filter((t) => t.category === "safe");
    expect(safe.length).toBeGreaterThanOrEqual(2);
    expect(safe.map((t) => t.id)).toContain("pinchy_ls");
    expect(safe.map((t) => t.id)).toContain("pinchy_read");
  });

  it("contains docs_list and docs_read as safe tools (no group, not denied)", () => {
    const ids = TOOL_REGISTRY.map((t) => t.id);
    expect(ids).toContain("docs_list");
    expect(ids).toContain("docs_read");
    const docsList = getToolById("docs_list");
    const docsRead = getToolById("docs_read");
    expect(docsList?.category).toBe("safe");
    expect(docsRead?.category).toBe("safe");
    expect(docsList?.group).toBeUndefined();
    expect(docsRead?.group).toBeUndefined();
  });

  it("contains powerful tools", () => {
    const powerful = TOOL_REGISTRY.filter((t) => t.category === "powerful");
    expect(powerful.length).toBe(5);
    expect(powerful.map((t) => t.id)).toEqual([
      "odoo_create",
      "odoo_write",
      "odoo_delete",
      "email_draft",
      "email_send",
    ]);
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

  it("non-integration tools don't have integration set", () => {
    const nonIntegrationTools = TOOL_REGISTRY.filter(
      (t) => !t.id.startsWith("odoo_") && !t.id.startsWith("email_")
    );
    for (const tool of nonIntegrationTools) {
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

  // --- Email tools ---

  it("email tools are registered in TOOL_REGISTRY", () => {
    const emailTools = TOOL_REGISTRY.filter((t) => t.integration === "email");
    expect(emailTools).toHaveLength(5);

    const ids = emailTools.map((t) => t.id);
    expect(ids).toContain("email_list");
    expect(ids).toContain("email_read");
    expect(ids).toContain("email_search");
    expect(ids).toContain("email_draft");
    expect(ids).toContain("email_send");
  });

  it("email read tools are safe category, send is powerful", () => {
    expect(getToolById("email_list")?.category).toBe("safe");
    expect(getToolById("email_read")?.category).toBe("safe");
    expect(getToolById("email_search")?.category).toBe("safe");
    expect(getToolById("email_draft")?.category).toBe("powerful");
    expect(getToolById("email_send")?.category).toBe("powerful");
  });

  it("getEmailTools() returns exactly 5 tools", () => {
    const tools = getEmailTools();
    expect(tools).toHaveLength(5);
    expect(tools.every((t) => t.integration === "email")).toBe(true);
  });
});
