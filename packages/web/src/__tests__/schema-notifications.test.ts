import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { notifications } from "@/db/schema";

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
    expect(idx!.config.columns.map((col: { name: string }) => col.name)).toEqual([
      "agent_id",
      "created_at",
    ]);
  });
});
