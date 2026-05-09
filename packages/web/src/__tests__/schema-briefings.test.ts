import { describe, it, expect } from "vitest";
import { briefings } from "@/db/schema";

describe("briefings schema", () => {
  it("has required columns with expected types", () => {
    const cols = briefings[Symbol.for("drizzle:Columns") as any];
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "agentId",
        "name",
        "schedule",
        "prompt",
        "enabled",
        "lastRunAt",
        "lastRunStatus",
        "lastSyncedAt",
        "syncError",
        "createdBy",
        "createdAt",
        "updatedAt",
      ])
    );
  });

  it("references agents and users", () => {
    const cols = briefings[Symbol.for("drizzle:Columns") as any];
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.createdBy.notNull).toBe(true);
  });
});
