import { describe, it, expect } from "vitest";
import {
  incompletePermissionsDetail,
  incompletePermissionsWarning,
} from "@/lib/agent-permission-gaps";
import type { IncompleteConnectionPermissions } from "@/lib/agents";

const agent = { id: "agent-1", name: "Quill" };

function gap(over: Partial<IncompleteConnectionPermissions> = {}): IncompleteConnectionPermissions {
  return {
    connectionId: "conn-1",
    connectionName: "My Odoo",
    missingModels: [],
    deniedOperations: [],
    warnings: [],
    ...over,
  };
}

describe("incompletePermissionsDetail", () => {
  it("names the connection as well as its id, so a deleted connection stays readable", () => {
    expect(
      incompletePermissionsDetail(
        agent,
        gap({
          missingModels: ["account.bank.statement.line"],
          warnings: ["account.bank.statement.line: model not available"],
        })
      )
    ).toEqual({
      action: "agent_integration_permissions_incomplete",
      agentId: "agent-1",
      name: "Quill",
      connectionId: "conn-1",
      connectionName: "My Odoo",
      missingModels: ["account.bank.statement.line"],
      deniedOperations: [],
      warnings: ["account.bank.statement.line: model not available"],
    });
  });

  it("carries denied operations, not only absent models", () => {
    const detail = incompletePermissionsDetail(
      agent,
      gap({ deniedOperations: [{ model: "account.move", operations: ["write"] }] })
    );
    expect(detail.deniedOperations).toEqual([{ model: "account.move", operations: ["write"] }]);
  });
});

describe("incompletePermissionsWarning", () => {
  // The field has to stay ABSENT on a clean create — the provisioning API
  // reference tells callers that its presence is the signal.
  it("is undefined when nothing is missing", () => {
    expect(incompletePermissionsWarning([])).toBeUndefined();
    expect(incompletePermissionsWarning(undefined)).toBeUndefined();
  });

  it("names the missing models and how to fix them", () => {
    const warning = incompletePermissionsWarning([
      gap({ missingModels: ["account.bank.statement.line"] }),
    ]);
    expect(warning).toContain('"My Odoo"');
    expect(warning).toContain("account.bank.statement.line");
    expect(warning).toContain("Re-sync");
  });

  it("names denied operations with the operations themselves", () => {
    const warning = incompletePermissionsWarning([
      gap({ deniedOperations: [{ model: "account.move", operations: ["write", "create"] }] }),
    ]);
    expect(warning).toContain("account.move (write, create)");
  });

  // "Re-sync the schema" is wrong advice for a connection that isn't there —
  // it would send an admin looking for a row they cannot open.
  it("says the connection is gone rather than telling the admin to re-sync it", () => {
    const warning = incompletePermissionsWarning([
      gap({ connectionName: null, connectionId: "gone", missingModels: ["account.move"] }),
    ]);
    expect(warning).toContain("gone");
    expect(warning).toContain("no longer exists");
    expect(warning).not.toContain("Re-sync");
  });
});
