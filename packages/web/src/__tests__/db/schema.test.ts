import { describe, it, expect, expectTypeOf } from "vitest";
import * as schema from "@/db/schema";
import type { AgentPluginConfig, AuditDetail } from "@/db/schema";

const { agents, settings, invites, auditLog } = schema;

describe("database schema", () => {
  it("should export agents table", () => {
    expect(agents).toBeDefined();
  });

  it("should export settings table", () => {
    expect(settings).toBeDefined();
  });

  it("agents table should have expected columns", () => {
    const columns = Object.keys(agents);
    expect(columns).toContain("id");
    expect(columns).toContain("name");
    expect(columns).toContain("model");
    expect(columns).toContain("createdAt");
  });

  it("settings table should have expected columns", () => {
    const columns = Object.keys(settings);
    expect(columns).toContain("key");
    expect(columns).toContain("value");
    expect(columns).toContain("encrypted");
  });
});

describe("agents schema — template and plugin columns", () => {
  it("should have templateId column", () => {
    expect(agents.templateId).toBeDefined();
  });

  it("should have pluginConfig column", () => {
    expect(agents.pluginConfig).toBeDefined();
  });
});

describe("agents schema — ownership columns", () => {
  it("should have ownerId column", () => {
    expect(agents.ownerId).toBeDefined();
  });

  it("should have isPersonal column", () => {
    expect(agents.isPersonal).toBeDefined();
  });
});

describe("invites schema", () => {
  it("should be exported", () => {
    expect(invites).toBeDefined();
  });

  it("should have all expected columns", () => {
    const columns = Object.keys(invites);
    expect(columns).toContain("id");
    expect(columns).toContain("tokenHash");
    expect(columns).toContain("email");
    expect(columns).toContain("role");
    expect(columns).toContain("type");
    expect(columns).toContain("createdBy");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("expiresAt");
    expect(columns).toContain("claimedAt");
    expect(columns).toContain("claimedByUserId");
  });
});

describe("agents schema — allowedTools column", () => {
  it("agents table has allowedTools column", () => {
    expect(agents.allowedTools).toBeDefined();
  });
});

describe("agents schema — greetingMessage column", () => {
  it("should have a greetingMessage column on agents table", () => {
    expect(agents.greetingMessage).toBeDefined();
  });
});

describe("agents schema — personality columns", () => {
  it("should have tagline column", () => {
    expect(agents.tagline).toBeDefined();
  });

  it("should have avatarSeed column", () => {
    expect(agents.avatarSeed).toBeDefined();
  });

  it("should have personalityPresetId column", () => {
    expect(agents.personalityPresetId).toBeDefined();
  });
});

describe("agentRoles removal", () => {
  it("should NOT export agentRoles", () => {
    expect("agentRoles" in schema).toBe(false);
  });
});

describe("soft-delete columns", () => {
  it("agents table has deletedAt column", () => {
    expect(agents.deletedAt).toBeDefined();
  });
});

describe("soft-delete views", () => {
  it("exports activeAgents view", () => {
    expect(schema.activeAgents).toBeDefined();
  });
});

describe("JSON column types — compile-time contracts", () => {
  // expectTypeOf is a compile-time assertion (no-op at runtime). These tests
  // document the schema's type contracts and exist as regression guards
  // alongside production code that imports and uses the same types.

  it("agents.pluginConfig is typed AgentPluginConfig | null (not unknown)", () => {
    type Row = typeof agents.$inferSelect;
    expectTypeOf<Row["pluginConfig"]>().toEqualTypeOf<AgentPluginConfig | null>();
  });

  it("AgentPluginConfig is namespaced by plugin ID", () => {
    // Top-level keys are plugin IDs — the namespacing this test guards. Catches
    // a renamed/removed plugin key, unlike the old toMatchObjectType assertion
    // which silently drifted once pinchy-files/pinchy-web grew extra fields.
    expectTypeOf<keyof AgentPluginConfig>().toEqualTypeOf<"pinchy-files" | "pinchy-web">();
    // Each plugin's key config field keeps its type. Asserting the specific
    // fields (not the whole object) stays green when a plugin gains new optional
    // config, while still catching a type change on the fields that matter.
    expectTypeOf<NonNullable<AgentPluginConfig["pinchy-files"]>["allowed_paths"]>().toEqualTypeOf<
      string[]
    >();
    expectTypeOf<NonNullable<AgentPluginConfig["pinchy-web"]>["allowedDomains"]>().toEqualTypeOf<
      string[] | undefined
    >();
  });

  it("auditLog.detail is typed AuditDetail | null (not unknown)", () => {
    type Row = typeof auditLog.$inferSelect;
    expectTypeOf<Row["detail"]>().toEqualTypeOf<AuditDetail | null>();
  });
});
