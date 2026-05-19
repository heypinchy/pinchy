import { describe, it, expectTypeOf } from "vitest";
import type { AuditLogEntry, AuditEventType } from "@/lib/audit";

describe("AuditLogEntry agent.memory_changed", () => {
  it("accepts the expected detail shape", () => {
    const entry: AuditLogEntry = {
      actorType: "agent",
      actorId: "agent-123",
      eventType: "agent.memory_changed",
      resource: "agent:agent-123",
      outcome: "success",
      detail: {
        agent: { id: "agent-123", name: "Smithers" },
        file: "MEMORY.md",
        addedLines: 3,
        removedLines: 1,
        byteSize: 512,
      },
    };
    expectTypeOf(entry.eventType).toEqualTypeOf<AuditEventType>();
  });
});
