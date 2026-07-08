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

describe("AuditLogEntry channel.auto_disabled (#477 layer 2)", () => {
  it("accepts the expected detail shape", () => {
    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "channel-watchdog",
      eventType: "channel.auto_disabled",
      resource: "agent:agent-123",
      outcome: "success",
      detail: {
        channel: "telegram",
        account: { id: "agent-123", name: "Support Bot" },
        reason: "polling_conflict",
        lastError: "Conflict: terminated by other getUpdates request",
      },
    };
    expectTypeOf(entry.eventType).toEqualTypeOf<AuditEventType>();
  });
});
