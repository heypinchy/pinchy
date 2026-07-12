import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { emailWorkflows } from "@/db/schema";

describe("email_workflows schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(emailWorkflows)))).toEqual(
      new Set([
        "id",
        "agentId",
        "name",
        "filter",
        "action",
        "pollEvery",
        "sweepWindowDays",
        "enabled",
        "status",
        "openclawJobId",
        "createdBy",
        "createdAt",
        "updatedAt",
      ])
    );
  });

  it("requires agentId and defaults enabled=false, status=pending", () => {
    const c = getTableColumns(emailWorkflows);
    expect(c.agentId.notNull).toBe(true);
    expect(c.enabled.default).toBe(false);
    expect(c.status.default).toBe("pending");
  });

  it("indexes only enabled workflows (partial index)", () => {
    const { indexes } = getTableConfig(emailWorkflows);
    const enabled = indexes.find((i) => i.config.name === "email_workflows_enabled_idx");
    expect(enabled).toBeDefined();
    // A partial index carries a WHERE predicate; a plain boolean index would not.
    expect(enabled!.config.where).toBeDefined();
  });
});
