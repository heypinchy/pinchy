import { describe, it, expect } from "vitest";
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
});
