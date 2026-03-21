import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/db/schema";

describe("usageRecords schema", () => {
  it("should be exported", () => {
    expect(schema.usageRecords).toBeDefined();
  });

  it("should have table name usage_records", () => {
    expect(getTableName(schema.usageRecords)).toBe("usage_records");
  });

  it("should have all required columns", () => {
    const columns = Object.keys(schema.usageRecords);
    expect(columns).toContain("id");
    expect(columns).toContain("timestamp");
    expect(columns).toContain("userId");
    expect(columns).toContain("agentId");
    expect(columns).toContain("agentName");
    expect(columns).toContain("sessionKey");
    expect(columns).toContain("model");
    expect(columns).toContain("inputTokens");
    expect(columns).toContain("outputTokens");
    expect(columns).toContain("cacheReadTokens");
    expect(columns).toContain("cacheWriteTokens");
    expect(columns).toContain("estimatedCostUsd");
  });
});
