import { describe, it, expectTypeOf } from "vitest";
import type { AuditEventType, AuditResource } from "@/lib/audit";

describe("audit types for briefings", () => {
  it("includes briefing.* event types", () => {
    expectTypeOf<"briefing.created">().toMatchTypeOf<AuditEventType>();
    expectTypeOf<"briefing.updated">().toMatchTypeOf<AuditEventType>();
    expectTypeOf<"briefing.deleted">().toMatchTypeOf<AuditEventType>();
  });

  it("includes 'briefing' in AuditResource", () => {
    expectTypeOf<"briefing">().toMatchTypeOf<AuditResource>();
  });
});
