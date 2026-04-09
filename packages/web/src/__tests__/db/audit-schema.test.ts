import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

describe("audit log schema", () => {
  it("should export actorTypeEnum", () => {
    expect(schema.actorTypeEnum).toBeDefined();
  });

  it("actorTypeEnum should have correct values", () => {
    expect(schema.actorTypeEnum.enumValues).toEqual(["user", "agent", "system"]);
  });

  it("should export auditLog table", () => {
    expect(schema.auditLog).toBeDefined();
  });

  it("auditLog table should have all required columns", () => {
    const columns = Object.keys(schema.auditLog);
    expect(columns).toContain("id");
    expect(columns).toContain("timestamp");
    expect(columns).toContain("actorType");
    expect(columns).toContain("actorId");
    expect(columns).toContain("eventType");
    expect(columns).toContain("resource");
    expect(columns).toContain("detail");
    expect(columns).toContain("rowHmac");
  });

  it("should have version, outcome, and error columns", () => {
    expect(schema.auditLog.version).toBeDefined();
    expect(schema.auditLog.outcome).toBeDefined();
    expect(schema.auditLog.error).toBeDefined();
  });

  it("version column is notNull with default 1", () => {
    expect(schema.auditLog.version.notNull).toBe(true);
    expect(schema.auditLog.version.default).toBe(1);
  });

  it("outcome column is nullable", () => {
    expect(schema.auditLog.outcome.notNull).toBe(false);
  });

  it("error column is nullable", () => {
    expect(schema.auditLog.error.notNull).toBe(false);
  });

  it("should declare idx_audit_outcome index", () => {
    const config = getTableConfig(schema.auditLog);
    const indexNames = config.indexes.map((i) => i.config.name);
    expect(indexNames).toContain("idx_audit_outcome");
  });

  it("should declare audit_log_v2_outcome_required check constraint", () => {
    const config = getTableConfig(schema.auditLog);
    const checkNames = config.checks.map((c) => c.name);
    expect(checkNames).toContain("audit_log_v2_outcome_required");
  });
});
