import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { emailWorkflowConnections } from "@/db/schema";

describe("email_workflow_connections schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(emailWorkflowConnections)))).toEqual(
      new Set(["workflowId", "connectionId", "sinceTs", "addedAt"])
    );
  });

  it("requires workflowId, connectionId and sinceTs", () => {
    const c = getTableColumns(emailWorkflowConnections);
    expect(c.workflowId.notNull).toBe(true);
    expect(c.connectionId.notNull).toBe(true);
    expect(c.sinceTs.notNull).toBe(true);
  });

  it("has a composite primary key on (workflowId, connectionId)", () => {
    const { primaryKeys } = getTableConfig(emailWorkflowConnections);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0].columns.map((col) => col.name)).toEqual(["workflow_id", "connection_id"]);
  });
});
