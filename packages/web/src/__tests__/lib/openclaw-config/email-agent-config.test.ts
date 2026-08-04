import { describe, it, expect } from "vitest";
import {
  aggregateEmailPermissionsByAgent,
  buildEmailAgentConfigs,
  type JoinedPermissionRow,
} from "@/lib/openclaw-config/email-agent-config";

/**
 * Minimal integration_connections fixture. Only the fields the two functions
 * under test actually read (`type`, `id`, `name`, `data`) are meaningful;
 * the rest are present to satisfy the schema-derived type and deliberately
 * carry a plausible-looking encrypted-credentials string so the "no plaintext
 * secret in output" test below has something real to check against.
 */
function makeConnection(
  overrides: Partial<JoinedPermissionRow["integration_connections"]> = {}
): JoinedPermissionRow["integration_connections"] {
  return {
    id: "conn-1",
    type: "google",
    name: "Gmail",
    description: "",
    credentials: "ENCRYPTED:super-secret-refresh-token",
    data: null,
    status: "active",
    lastError: null,
    lastErrorAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as JoinedPermissionRow["integration_connections"];
}

function makePermission(
  overrides: Partial<JoinedPermissionRow["agent_connection_permissions"]> = {}
): JoinedPermissionRow["agent_connection_permissions"] {
  return {
    id: "perm-1",
    agentId: "agent-1",
    connectionId: "conn-1",
    model: "email",
    operation: "read",
    ...overrides,
  } as JoinedPermissionRow["agent_connection_permissions"];
}

function row(
  permOverrides: Partial<JoinedPermissionRow["agent_connection_permissions"]> = {},
  connOverrides: Partial<JoinedPermissionRow["integration_connections"]> = {}
): JoinedPermissionRow {
  return {
    agent_connection_permissions: makePermission(permOverrides),
    integration_connections: makeConnection(connOverrides),
  };
}

describe("aggregateEmailPermissionsByAgent", () => {
  it("ignores connections that are not an email provider type", () => {
    const rows: JoinedPermissionRow[] = [
      row({ agentId: "agent-1", connectionId: "odoo-conn" }, { id: "odoo-conn", type: "odoo" }),
    ];

    const result = aggregateEmailPermissionsByAgent(rows);

    expect(result.size).toBe(0);
  });

  it("accepts every EMAIL_CONNECTION_TYPES member (google, microsoft, imap)", () => {
    const rows: JoinedPermissionRow[] = [
      row({ agentId: "agent-google" }, { type: "google" }),
      row({ agentId: "agent-microsoft" }, { type: "microsoft" }),
      row({ agentId: "agent-imap" }, { type: "imap" }),
    ];

    const result = aggregateEmailPermissionsByAgent(rows);

    expect(new Set(result.keys())).toEqual(
      new Set(["agent-google", "agent-microsoft", "agent-imap"])
    );
  });

  it("merges operations across multiple permission rows for the same agent+model", () => {
    const rows: JoinedPermissionRow[] = [
      row({ agentId: "agent-1", model: "email", operation: "read" }),
      row({ agentId: "agent-1", model: "email", operation: "draft" }),
    ];

    const result = aggregateEmailPermissionsByAgent(rows);

    expect(result.get("agent-1")?.ops.get("email")).toEqual(["read", "draft"]);
  });

  it("keeps the FIRST-seen connection for connectionId/connection but tracks all connectionIds (LATENT FIRST-WINS)", () => {
    const rows: JoinedPermissionRow[] = [
      row(
        { agentId: "agent-1", connectionId: "conn-first" },
        { id: "conn-first", name: "First Inbox" }
      ),
      row(
        { agentId: "agent-1", connectionId: "conn-second" },
        { id: "conn-second", name: "Second Inbox" }
      ),
    ];

    const result = aggregateEmailPermissionsByAgent(rows);
    const agentData = result.get("agent-1");

    expect(agentData?.connectionId).toBe("conn-first");
    expect(agentData?.connection.id).toBe("conn-first");
    expect(agentData?.connectionIds).toEqual(new Set(["conn-first", "conn-second"]));
  });

  it("returns an empty map for no rows", () => {
    expect(aggregateEmailPermissionsByAgent([]).size).toBe(0);
  });
});

describe("buildEmailAgentConfigs", () => {
  it("derives email_* read tools from a plain 'read' operation", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "email", operation: "read" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toEqual([
      "email_list",
      "email_read",
      "email_search",
      "email_get_attachment",
    ]);
  });

  it("grants the same read toolset for legacy 'search'/'list' aliases without a 'read' row", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "email", operation: "search" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toEqual([
      "email_list",
      "email_read",
      "email_search",
      "email_get_attachment",
    ]);
  });

  it("adds draft/send tools only when explicitly granted, never implied by read", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "email", operation: "read" }),
      row({ agentId: "agent-1", model: "email", operation: "draft" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toContain("email_draft");
    expect(configs["agent-1"].tools).not.toContain("email_send");
  });

  it("emits an empty tools array when the agent has no 'email' model ops", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "some-other-model", operation: "read" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toEqual([]);
    // The unrelated model's ops are still surfaced in `permissions` even
    // though they don't map to any tool.
    expect(configs["agent-1"].permissions).toEqual({ "some-other-model": ["read"] });
  });

  it("returns an empty object for an empty aggregation", () => {
    expect(buildEmailAgentConfigs(new Map())).toEqual({});
  });

  it("carries connectionId + permissions per agent, keyed by model", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", connectionId: "conn-1", model: "email", operation: "read" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].connectionId).toBe("conn-1");
    expect(configs["agent-1"].permissions).toEqual({ email: ["read"] });
  });

  it("never leaks the connection's encrypted credentials into the emitted plugin config", () => {
    // Security-relevant edge: emailAgentConfigs feeds directly into
    // plugins.entries.pinchy-email.config.agents in build.ts. The plugin
    // fetches credentials itself via the internal API — the emitted config
    // must carry no more than connectionId/permissions/tools.
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row(
        { agentId: "agent-1", connectionId: "conn-1", model: "email", operation: "read" },
        { credentials: "ENCRYPTED:super-secret-refresh-token" }
      ),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);
    const serialized = JSON.stringify(configs);

    expect(Object.keys(configs["agent-1"]).sort()).toEqual([
      "connectionId",
      "permissions",
      "tools",
    ]);
    expect(serialized).not.toContain("super-secret-refresh-token");
  });
});
