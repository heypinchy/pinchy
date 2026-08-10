import { describe, it, expect } from "vitest";
import {
  aggregateEmailPermissionsByAgent,
  buildEmailAgentConfigs,
  type JoinedPermissionRow,
} from "@/lib/openclaw-config/email-agent-config";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { EMAIL_READ_OPERATIONS } from "@/lib/tool-registry";

/**
 * Minimal integration_connections fixture. Only the fields the two functions
 * under test actually read (`type`, `id`, `name`, `data`) are meaningful;
 * the rest are spelled out because the fixture is checked against the
 * schema-derived type — no `as` cast, so a new NOT NULL column shows up here
 * as a compile error instead of an absent field the code reads as undefined.
 * `credentials` deliberately carries a plausible-looking encrypted string so
 * the "no plaintext secret in output" test below has something real to check.
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
  };
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
  };
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

  // Driven off EMAIL_CONNECTION_TYPES itself, not a hand-written copy of it:
  // a fourth email provider added to the constant is then covered here the
  // moment it lands, instead of leaving a test whose name claims "every
  // member" while it checks three.
  it("accepts every EMAIL_CONNECTION_TYPES member", () => {
    const rows: JoinedPermissionRow[] = EMAIL_CONNECTION_TYPES.map((type) =>
      row({ agentId: `agent-${type}` }, { type })
    );

    const result = aggregateEmailPermissionsByAgent(rows);

    expect(new Set(result.keys())).toEqual(
      new Set(EMAIL_CONNECTION_TYPES.map((type) => `agent-${type}`))
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

  // Every alias in EMAIL_READ_OPERATIONS, not just "search": a legacy
  // list-only agent (pre-#328 rows, no accompanying "read") must derive the
  // same toolset, and deriving the cases from the constant keeps a future
  // alias from slipping past a hand-written pair.
  it.each(EMAIL_READ_OPERATIONS.filter((op) => op !== "read"))(
    "grants the same read toolset for the legacy '%s' alias without a 'read' row",
    (operation) => {
      const emailPermsByAgent = aggregateEmailPermissionsByAgent([
        row({ agentId: "agent-1", model: "email", operation }),
      ]);

      const configs = buildEmailAgentConfigs(emailPermsByAgent);

      expect(configs["agent-1"].tools).toEqual([
        "email_list",
        "email_read",
        "email_search",
        "email_get_attachment",
      ]);
    }
  );

  // The half a derived test cannot see: drop "list" from the constant and the
  // case above simply vanishes rather than going red. Nothing else in the repo
  // pins the alias list, so a legacy list-only agent losing every email tool
  // would ship silently.
  it("keeps the legacy read aliases in EMAIL_READ_OPERATIONS", () => {
    expect(EMAIL_READ_OPERATIONS).toContain("search");
    expect(EMAIL_READ_OPERATIONS).toContain("list");
  });

  it("adds draft tools only when explicitly granted, never implied by read", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "email", operation: "read" }),
      row({ agentId: "agent-1", model: "email", operation: "draft" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toContain("email_draft");
    expect(configs["agent-1"].tools).not.toContain("email_send");
  });

  // The other half of the same rule: send is the most consequential grant in
  // the set, so it gets its own pin rather than only ever being asserted
  // absent above.
  it("adds email_send only when 'send' is granted, and not email_draft with it", () => {
    const emailPermsByAgent = aggregateEmailPermissionsByAgent([
      row({ agentId: "agent-1", model: "email", operation: "read" }),
      row({ agentId: "agent-1", model: "email", operation: "send" }),
    ]);

    const configs = buildEmailAgentConfigs(emailPermsByAgent);

    expect(configs["agent-1"].tools).toContain("email_send");
    expect(configs["agent-1"].tools).not.toContain("email_draft");
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
