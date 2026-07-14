import { describe, it, expect } from "vitest";
import {
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  computeAllowedTools,
  getOdooTools,
  getOdooToolsForAccessLevel,
  detectOdooAccessLevel,
  getEmailTools,
  getEmailToolsForOperations,
  detectEmailOperations,
} from "@/lib/tool-registry";
import { getAllPinchyPluginToolNames } from "@/lib/openclaw-config/plugin-manifest-loader";

describe("TOOL_REGISTRY", () => {
  it("contains safe tools", () => {
    const safe = TOOL_REGISTRY.filter((t) => t.category === "safe");
    expect(safe.length).toBeGreaterThanOrEqual(2);
    // pinchy_ls and pinchy_read are now implicit — not in registry
    expect(safe.map((t) => t.id)).not.toContain("pinchy_ls");
    expect(safe.map((t) => t.id)).not.toContain("pinchy_read");
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
    expect(powerful.length).toBe(17);
    expect(powerful.map((t) => t.id)).toEqual([
      "pinchy_web_search",
      "pinchy_web_fetch",
      "odoo_create",
      "odoo_schedule_activity",
      "odoo_complete_activity",
      "odoo_reschedule_activity",
      "odoo_confirm_order",
      "odoo_apply_inventory",
      "odoo_validate_picking",
      "odoo_mark_mo_done",
      "odoo_set_approval",
      "odoo_write",
      "odoo_delete",
      "odoo_attach_file",
      "email_draft",
      "email_send",
      "pinchy_write",
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
    const tool = getToolById("odoo_list_models");
    expect(tool?.label).toBe("Odoo: List models");
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

describe("computeAllowedTools", () => {
  it("does NOT allow the built-in `pdf`/`image` tools — they cannot read workspace uploads (prod incident 2026-07-14)", () => {
    // OpenClaw's built-in pdf/image media tools fail with "Local media file not
    // found" on workspace upload paths. attachment-pipeline routes every PDF and
    // image through the pinchy-files `pinchy_read` tool instead. Keeping the
    // built-ins in the allowlist handed weaker models (e.g. kimi-k2.6) a
    // temptingly-named trap they picked over `pinchy_read`, then reported the
    // attached file as unreadable even though it was present on disk.
    const allowed = computeAllowedTools();
    expect(allowed).not.toContain("pdf");
    expect(allowed).not.toContain("image");
    // The intended media reader stays available.
    expect(allowed).toContain("pinchy_read");
  });

  it("allows memory_search/memory_get (bundled memory-core plugin powers agent memory)", () => {
    const allowed = computeAllowedTools();
    expect(allowed).toContain("memory_search");
    expect(allowed).toContain("memory_get");
  });

  it("allows session_status (read-only self-status, the baseline `minimal` tool)", () => {
    expect(computeAllowedTools()).toContain("session_status");
  });

  it("does NOT allow `image_generate` (produces new content, requires explicit opt-in)", () => {
    expect(computeAllowedTools()).not.toContain("image_generate");
  });

  it("includes every Pinchy plugin tool from the manifests (no plugin tool silently blocked)", () => {
    const allowed = new Set(computeAllowedTools());
    for (const tool of getAllPinchyPluginToolNames()) {
      expect(allowed.has(tool), `plugin tool "${tool}" must be in the allowlist`).toBe(true);
    }
  });

  it("is fail-closed: never allows raw runtime/fs/web/ui or other powerful built-ins", () => {
    const allowed = new Set(computeAllowedTools());
    const mustNeverAllow = [
      "exec",
      "process",
      "code_execution",
      "read",
      "write",
      "edit",
      "apply_patch",
      "web_search",
      "x_search",
      "web_fetch",
      "browser",
      "canvas",
      "cron",
      "gateway",
      "message",
      "nodes",
      "subagents",
      "sessions_spawn",
      "sessions_send",
      "tts",
      "music_generate",
      "video_generate",
    ];
    for (const tool of mustNeverAllow) {
      expect(allowed.has(tool), `built-in "${tool}" must NOT be in the allowlist`).toBe(false);
    }
  });
});

describe("allow-list drift guard vs OpenClaw built-in tool groups", () => {
  // OpenClaw built-in tool → group membership, transcribed from
  // docs/gateway/config-tools.md (OpenClaw 2026.6.8). Re-check on every OpenClaw
  // upgrade: if a powerful built-in is added or moves group, update this fixture
  // — which forces a conscious decision about whether the allowlist should keep
  // excluding it. Because Pinchy now emits an ALLOWlist (not a deny list), any
  // new built-in is denied by default; this guard exists to prove the dangerous
  // ones stay out and the intended read-only ones stay in.
  const OPENCLAW_TOOL_GROUPS: Record<string, readonly string[]> = {
    "group:runtime": ["exec", "process", "code_execution"],
    "group:fs": ["read", "write", "edit", "apply_patch"],
    "group:web": ["web_search", "x_search", "web_fetch"],
    "group:ui": ["browser", "canvas"],
    "group:automation": ["heartbeat_respond", "cron", "gateway"],
    "group:messaging": ["message"],
    "group:nodes": ["nodes"],
    "group:media": ["image", "image_generate", "music_generate", "video_generate", "tts"],
    // group:sessions — subagents/session spawning/cross-session messaging.
    "group:sessions": [
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
      "session_status",
    ],
  };

  // Built-in tools a governed Pinchy agent must NEVER reach: code execution, raw
  // filesystem/web, the real browser/canvas, scheduling + gateway control,
  // cross-session/agent fan-out, outbound messaging/nodes, and content
  // generators. Pinchy exposes none of these — it ships permissioned, audited
  // pinchy_* equivalents (or governs them through its own config) instead.
  const MUST_NOT_ALLOW_BUILTINS = [
    "exec",
    "process",
    "code_execution",
    "read",
    "write",
    "edit",
    "apply_patch",
    "web_search",
    "x_search",
    "web_fetch",
    "browser",
    "canvas",
    "cron",
    "gateway",
    "message",
    "nodes",
    "subagents",
    "sessions_spawn",
    "sessions_send",
    "image_generate",
    "music_generate",
    "video_generate",
    "tts",
  ] as const;

  // The ONLY non-Pinchy tools the allowlist may contain (bundled memory-core +
  // read-only self-status). Everything in group:media — including the `pdf` and
  // `image` built-ins — must stay out: chat attachments are read via the
  // pinchy-files `pinchy_read` tool, not the built-ins (see the tool-registry
  // comment on INTENDED_BUILTIN_TOOLS and the 2026-07-14 prod incident).
  const INTENDED_BUILTINS = ["memory_search", "memory_get", "session_status"];

  it("excludes every built-in a governed agent must never reach", () => {
    const allowed = new Set(computeAllowedTools());
    for (const tool of MUST_NOT_ALLOW_BUILTINS) {
      const group = Object.entries(OPENCLAW_TOOL_GROUPS).find(([, tools]) =>
        tools.includes(tool)
      )?.[0];
      expect(
        allowed.has(tool),
        `built-in "${tool}" (group ${group ?? "none"}) must be excluded from the allowlist`
      ).toBe(false);
    }
  });

  it("excludes the native browser/canvas (group:ui) — preserves the #603 boundary", () => {
    const allowed = computeAllowedTools();
    expect(allowed).not.toContain("browser");
    expect(allowed).not.toContain("canvas");
  });

  it("allows no non-Pinchy tool beyond the intended read-only built-ins", () => {
    const pluginTools = new Set(getAllPinchyPluginToolNames());
    const nonPinchy = computeAllowedTools().filter((t) => !pluginTools.has(t));
    expect(nonPinchy.sort()).toEqual([...INTENDED_BUILTINS].sort());
  });
});

describe("Odoo access level helpers", () => {
  it("all odoo tools have integration: 'odoo'", () => {
    const odooTools = TOOL_REGISTRY.filter((t) => t.id.startsWith("odoo_"));
    // 17 active tools + 1 deprecated alias (odoo_schema) = 18.
    expect(odooTools.length).toBe(18);
    for (const tool of odooTools) {
      expect(tool.integration).toBe("odoo");
    }
  });

  it("odoo_schema is registered as a deprecated alias", () => {
    const odooSchema = TOOL_REGISTRY.find((t) => t.id === "odoo_schema");
    expect(odooSchema).toBeDefined();
    expect(odooSchema?.deprecated).toBe(true);
  });

  it("odoo_schema is NOT included in any access-level preset", () => {
    for (const level of ["read-only", "read-write", "full", "custom"] as const) {
      expect(getOdooToolsForAccessLevel(level)).not.toContain("odoo_schema");
    }
  });

  it("detectOdooAccessLevel ignores odoo_schema when matching presets", () => {
    // A read-only agent that picked up the compat alias must still classify
    // as "read-only" (not "custom"), otherwise the UI loses its preset.
    expect(
      detectOdooAccessLevel([
        "odoo_list_models",
        "odoo_describe_model",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
        "odoo_schema",
      ])
    ).toBe("read-only");
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

  it("getOdooToolsForAccessLevel('read-only') returns exactly the 5 read tools", () => {
    const tools = getOdooToolsForAccessLevel("read-only");
    expect(tools).toEqual([
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
    ]);
  });

  it("getOdooToolsForAccessLevel('read-write') returns 16 tools", () => {
    const tools = getOdooToolsForAccessLevel("read-write");
    expect(tools).toEqual([
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_schedule_activity",
      "odoo_complete_activity",
      "odoo_reschedule_activity",
      "odoo_confirm_order",
      "odoo_apply_inventory",
      "odoo_validate_picking",
      "odoo_mark_mo_done",
      "odoo_set_approval",
      "odoo_write",
      "odoo_attach_file",
    ]);
  });

  it("getOdooToolsForAccessLevel('full') returns all 17 tools", () => {
    const tools = getOdooToolsForAccessLevel("full");
    expect(tools).toEqual([
      "odoo_list_models",
      "odoo_describe_model",
      "odoo_read",
      "odoo_count",
      "odoo_aggregate",
      "odoo_create",
      "odoo_schedule_activity",
      "odoo_complete_activity",
      "odoo_reschedule_activity",
      "odoo_confirm_order",
      "odoo_apply_inventory",
      "odoo_validate_picking",
      "odoo_mark_mo_done",
      "odoo_set_approval",
      "odoo_write",
      "odoo_attach_file",
      "odoo_delete",
    ]);
  });

  it("getOdooToolsForAccessLevel('custom') returns list and describe tools", () => {
    const tools = getOdooToolsForAccessLevel("custom");
    expect(tools).toEqual(["odoo_list_models", "odoo_describe_model"]);
  });

  it("getOdooTools() returns exactly 18 tools (17 active + 1 deprecated alias)", () => {
    const tools = getOdooTools();
    expect(tools).toHaveLength(18);
    expect(tools.every((t) => t.integration === "odoo")).toBe(true);
  });

  it("detectOdooAccessLevel correctly identifies read-only preset", () => {
    expect(
      detectOdooAccessLevel([
        "odoo_list_models",
        "odoo_describe_model",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
      ])
    ).toBe("read-only");
  });

  it("detectOdooAccessLevel correctly identifies read-write preset", () => {
    expect(
      detectOdooAccessLevel([
        "odoo_list_models",
        "odoo_describe_model",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
        "odoo_create",
        "odoo_write",
        "odoo_attach_file",
      ])
    ).toBe("read-write");
  });

  it("detectOdooAccessLevel keeps a read-write agent classified after odoo_schedule_activity is added", () => {
    // New agents created from the updated preset carry odoo_schedule_activity;
    // it is additive and must still read as "read-write", not "custom".
    expect(
      detectOdooAccessLevel([
        "odoo_list_models",
        "odoo_describe_model",
        "odoo_read",
        "odoo_count",
        "odoo_aggregate",
        "odoo_create",
        "odoo_schedule_activity",
        "odoo_write",
        "odoo_attach_file",
      ])
    ).toBe("read-write");
  });

  it("detectOdooAccessLevel keeps a pre-existing read-write agent (without odoo_schedule_activity) classified", () => {
    // Production agents predate the tool and never received it. Their absence
    // of odoo_schedule_activity must NOT flip them to "custom".
    expect(
      detectOdooAccessLevel([
        "odoo_list_models",
        "odoo_describe_model",
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
        "odoo_list_models",
        "odoo_describe_model",
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
    // Only list_models + delete — not a standard preset
    expect(detectOdooAccessLevel(["odoo_list_models", "odoo_delete"])).toBe("custom");
  });

  it("detectOdooAccessLevel returns 'custom' when no odoo tools present", () => {
    expect(detectOdooAccessLevel(["pinchy_ls", "pinchy_read"])).toBe("custom");
  });

  // --- Email tools ---

  it("email tools are registered in TOOL_REGISTRY", () => {
    const emailTools = TOOL_REGISTRY.filter((t) => t.integration === "email");
    expect(emailTools).toHaveLength(6);

    const ids = emailTools.map((t) => t.id);
    expect(ids).toContain("email_list");
    expect(ids).toContain("email_read");
    expect(ids).toContain("email_search");
    expect(ids).toContain("email_get_attachment");
    expect(ids).toContain("email_draft");
    expect(ids).toContain("email_send");
  });

  it("email read tools are safe category, send is powerful", () => {
    expect(getToolById("email_list")?.category).toBe("safe");
    expect(getToolById("email_read")?.category).toBe("safe");
    expect(getToolById("email_search")?.category).toBe("safe");
    // Downloading an attachment writes only into the agent's own workspace
    // uploads dir (no external side effect) and is granted by the read
    // permission, so it stays in the "safe" category alongside the other reads.
    expect(getToolById("email_get_attachment")?.category).toBe("safe");
    expect(getToolById("email_draft")?.category).toBe("powerful");
    expect(getToolById("email_send")?.category).toBe("powerful");
  });

  it("getEmailTools() returns exactly 6 tools", () => {
    const tools = getEmailTools();
    expect(tools).toHaveLength(6);
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
        "email_get_attachment",
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
        "email_get_attachment",
        "email_draft",
        "email_send",
      ]);
    });

    it("returns empty for empty input", () => {
      expect(getEmailToolsForOperations([])).toEqual([]);
    });

    it("ignores unknown operations", () => {
      expect(getEmailToolsForOperations(["bogus"])).toEqual([]);
    });

    // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
    // pre-PR #328 template creation stored per-tool operations (list, read,
    // search, draft) as raw agent_connection_permissions rows — see
    // ebe6b47a2's "Operation vocabulary mismatch" fix, which normalized the
    // WRITE path via detectEmailOperations() but never touched pre-existing
    // rows. A legacy agent can therefore carry a standalone (email, "search")
    // row with NO accompanying "read" row. Before this fix,
    // getEmailToolsForOperations(["search"]) returned [] (silently dropping
    // ALL email tools for that agent, since "search" wasn't read as an
    // operation by this function). It must now derive the same toolset as
    // "read", matching the plugin's own gate (email_search checks "read").
    it("treats legacy 'search' operation as granting the read toolset (pre-#328 rows lacked a 'read' row)", () => {
      expect(getEmailToolsForOperations(["search"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_get_attachment",
      ]);
    });

    it("legacy 'search' does not additionally unlock draft/send", () => {
      const tools = getEmailToolsForOperations(["search"]);
      expect(tools).not.toContain("email_draft");
      expect(tools).not.toContain("email_send");
    });

    it("legacy 'search' combined with explicit 'read' does not duplicate read tools", () => {
      expect(getEmailToolsForOperations(["read", "search"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_get_attachment",
      ]);
    });

    // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
    // "list" is the OTHER legacy per-tool operation pre-#328 template creation
    // could persist (alongside "search" above), and unlike "search" it had NO
    // alias at all until now — a standalone (email, "list") row derived an
    // EMPTY toolset here, silently losing every email tool for that agent
    // after upgrading, the exact failure mode the "search" alias was meant to
    // prevent. "list" must derive the same toolset as "read", matching the
    // plugin's own gate (email_list/email_read/email_search/
    // email_get_attachment all check "read").
    it("treats legacy 'list' operation as granting the read toolset (pre-#328 rows lacked a 'read' row)", () => {
      expect(getEmailToolsForOperations(["list"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_get_attachment",
      ]);
    });

    it("legacy 'list' does not additionally unlock draft/send", () => {
      const tools = getEmailToolsForOperations(["list"]);
      expect(tools).not.toContain("email_draft");
      expect(tools).not.toContain("email_send");
    });

    it("legacy 'list' combined with explicit 'read' does not duplicate read tools", () => {
      expect(getEmailToolsForOperations(["read", "list"])).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_get_attachment",
      ]);
    });
  });

  describe("detectEmailOperations", () => {
    it("detects read from any read tool", () => {
      expect(detectEmailOperations(["email_list"])).toEqual(["read"]);
      expect(detectEmailOperations(["email_read"])).toEqual(["read"]);
      expect(detectEmailOperations(["email_search"])).toEqual(["read"]);
      expect(detectEmailOperations(["email_get_attachment"])).toEqual(["read"]);
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

describe("filesystem tools migration", () => {
  it("does not list pinchy_ls (now implicit, not user-toggleable)", () => {
    expect(getToolById("pinchy_ls")).toBeUndefined();
    expect(TOOL_REGISTRY.map((t) => t.id)).not.toContain("pinchy_ls");
  });

  it("does not list pinchy_read (now implicit, not user-toggleable)", () => {
    expect(getToolById("pinchy_read")).toBeUndefined();
    expect(TOOL_REGISTRY.map((t) => t.id)).not.toContain("pinchy_read");
  });

  it("lists pinchy_write as powerful with no requiresDirectories", () => {
    const tool = getToolById("pinchy_write");
    expect(tool).toBeDefined();
    expect(tool!.category).toBe("powerful");
    expect(tool).not.toHaveProperty("requiresDirectories");
  });
});
