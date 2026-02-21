import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";

const { agents, settings, invites, chatSessions } = schema;

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

describe("chatSessions schema", () => {
  it("chatSessions table exists with expected columns", () => {
    expect(chatSessions.id).toBeDefined();
    expect(chatSessions.sessionKey).toBeDefined();
    expect(chatSessions.userId).toBeDefined();
    expect(chatSessions.agentId).toBeDefined();
  });
});

describe("agentRoles removal", () => {
  it("should NOT export agentRoles", () => {
    expect("agentRoles" in schema).toBe(false);
  });
});
