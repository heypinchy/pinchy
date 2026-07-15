import { describe, it, expect } from "vitest";
import { getTableColumns, type SQL } from "drizzle-orm";
import { getTableConfig, type IndexedColumn } from "drizzle-orm/pg-core";
import { notifications } from "@/db/schema";

/**
 * `IndexConfig.columns` is `Partial<IndexedColumn | SQL>[]` — an index can
 * mix plain columns and raw SQL expressions, so drizzle's own type only
 * guarantees the properties common to both (effectively none). Every column
 * in this index is a plain column reference, never a raw SQL expression, so
 * this narrows to that real case instead of asserting `name` exists via a
 * cast.
 */
function indexedColumnName(col: Partial<IndexedColumn | SQL>): string {
  if (!("name" in col) || typeof col.name !== "string") {
    throw new Error("expected a plain IndexedColumn with a string name, not a raw SQL expression");
  }
  return col.name;
}

describe("notifications schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(notifications)))).toEqual(
      new Set([
        "id",
        "agentId",
        "sourceType",
        "sourceId",
        "title",
        "content",
        "status",
        "errorMessage",
        "createdAt",
      ])
    );
  });

  it("requires agentId, title, content and status", () => {
    const c = getTableColumns(notifications);
    expect(c.agentId.notNull).toBe(true);
    expect(c.title.notNull).toBe(true);
    expect(c.content.notNull).toBe(true);
    expect(c.status.notNull).toBe(true);
    // Source reference is deliberately optional and FK-less (survives source
    // deletion; either background feature can produce a notification).
    expect(c.sourceType.notNull).toBe(false);
    expect(c.sourceId.notNull).toBe(false);
  });

  it("has the (agentId, createdAt) feed index", () => {
    const { indexes } = getTableConfig(notifications);
    const idx = indexes.find((i) => i.config.name === "notifications_agent_created_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.columns.map(indexedColumnName)).toEqual(["agent_id", "created_at"]);
  });
});
