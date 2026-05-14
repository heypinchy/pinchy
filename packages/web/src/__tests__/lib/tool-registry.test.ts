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
  getEmailToolsForOperations,
  detectEmailOperations,
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
    expect(powerful.length).toBe(8);
    expect(powerful.map((t) => t.id)).toEqual([
      "pinchy_web_search",
      "pinchy_web_fetch",
      "odoo_create",
      "odoo_write",
      "odoo_delete",
      "odoo_attach_file",
      "email_draft",
      "email_send",
    ]);
  });

  it("contains pinchy_web_search as a powerful tool with no group", () => {
    const tool = getToolById("pinchy_web_search");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("powerful");
    expect(tool).not.toHaveProperty("group");
  });

  it("contains pinchy_web_fetch as a powerful tool with no group", () => {
    const tool = getToolById("pinchy_web_fetch");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("powerful");
    expect(tool).not.toHaveProperty("group");
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
  it("does not deny the OpenClaw built-in `pdf` tool — it powers chat-attachment PDF reading", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).not.toContain("pdf");
  });

  it("does not deny the OpenClaw built-in `image` tool — same reason for image attachments", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).not.toContain("image");
  });

  it("still denies `image_generate` (write/output tool, requires explicit opt-in)", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).toContain("image_generate");
  });

  it("always returns the base group deny list", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).toContain("group:runtime");
    expect(denied).toContain("group:fs");
    expect(denied).toContain("group:web");
  });

  it("returns same deny list even when tool IDs are passed (forward compat)", () => {
    const denied = computeDeniedGroups(["pinchy_ls", "odoo_create"]);
    expect(denied).not.toContain("pdf");
    expect(denied).not.toContain("image");
    expect(denied).toContain("image_generate");
  });
});

describe("Odoo access level helpers", () => {
  it("all odoo tools have integration: 'odoo'", () => {
    const odooTools = TOOL_REGISTRY.filter((t) => t.id.startsWith("odoo_"));
    expect(odooTools.length).toBe(8);
    for (const tool of odooTools) {
      expect(tool.integration).toBe("odoo");
    }
  });

  it("web search tools have integration: 'web-search'", () => {
    const webTools = TOOL_REGISTRY.filter((t) => t.id.startsWith("pinchy_web_"));
    expect(webTools.length).toBe(2);
    for (const tool of webTools) {
      expect(tool.integration).toBe("web-search");
    }
  });

  it("non-integration tools don't have integration set", () => {
    const nonIntegrationTools = TOOL_REGISTRY.filter(
      (t) =>
        !t.id.startsWith("odoo_") && !t.id.startsWith("email_") && !t.id.startsWith("pinchy_web_")
    );
    for (const tool of nonIntegrationTools) {
      expect(tool.integration).toBeUndefined();
    }
  });

  it("getOdooToolsForAccessLevel('read-only') returns exactly the 4 read tools", () => {
    const tools = getOdooToolsForAccessLevel("read-only");
    expect(tools).toEqual(["odoo_schema", "odoo_read", "odoo_count", "odoo_aggregate"]);
  });

  it("getOdooToolsForAccessLevel('read-write') returns 7 tools", () => {
    const tools = getOdooToolsForAccessLevel("read-write");
    expect(tools).toEqual([
      "odoo_schema",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_write",
      "odoo_attach_file",
    ]);
  });

  it("getOdooToolsForAccessLevel('full') returns all 8 tools", () => {
    const tools = getOdooToolsForAccessLevel("full");
    expect(tools).toEqual([
      "odoo_schema",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_write",
      "odoo_attach_file",
      "odoo_delete",
    ]);
  });

  it("getOdooToolsForAccessLevel('custom') returns only schema", () => {
    const tools = getOdooToolsForAccessLevel("custom");
    expect(tools).toEqual(["odoo_schema"]);
  });

  it("getOdooTools() returns exactly 8 tools", () => {
    const tools = getOdooTools();
    expect(tools).toHaveLength(8);
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
        "odoo_attach_file",
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
        "odoo_attach_file",
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

describe("Email operation helpers", () => {
  describe("getEmailToolsForOperations", () => {
    it("returns read tools for 'read' operation", () => {
      expect(getEmailToolsForOperations(["read"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
      ]);
    });

    it("returns draft tool for 'draft' operation", () => {
      expect(getEmailToolsForOperations(["draft"])).toEqual(["email_draft"]);
    });

    it("returns send tool for 'send' operation", () => {
      expect(getEmailToolsForOperations(["send"])).toEqual(["email_send"]);
    });

    it("returns all tools for all operations", () => {
      expect(getEmailToolsForOperations(["read", "draft", "send"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_draft",
        "email_send",
      ]);
    });

    it("returns empty for empty input", () => {
      expect(getEmailToolsForOperations([])).toEqual([]);
    });

    it("ignores unknown operations", () => {
      expect(getEmailToolsForOperations(["list", "search"])).toEqual([]);
    });
  });

  describe("detectEmailOperations", () => {
    it("detects read from any read tool", () => {
      expect(detectEmailOperations(["email_list"])).toEqual(["read"]);
      expect(detectEmailOperations(["email_read"])).toEqual(["read"]);
      expect(detectEmailOperations(["email_search"])).toEqual(["read"]);
    });

    it("detects draft from email_draft", () => {
      expect(detectEmailOperations(["email_draft"])).toEqual(["draft"]);
    });

    it("detects send from email_send", () => {
      expect(detectEmailOperations(["email_send"])).toEqual(["send"]);
    });

    it("detects multiple operations from mixed tool IDs", () => {
      expect(
        detectEmailOperations(["email_list", "email_read", "email_search", "email_draft"])
      ).toEqual(["read", "draft"]);
    });

    it("returns empty for non-email tools", () => {
      expect(detectEmailOperations(["pinchy_ls", "odoo_read"])).toEqual([]);
    });

    it("returns empty for empty input", () => {
      expect(detectEmailOperations([])).toEqual([]);
    });
  });
});
