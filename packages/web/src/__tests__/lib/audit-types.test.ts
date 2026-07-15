import { describe, it, expectTypeOf } from "vitest";
import type { AuditLogEntry, AuditEventType } from "@/lib/audit";

// Compile-time type tests. They run under `pnpm -C packages/web typecheck`
// (which type-checks test files); vitest does NOT type-check `expectTypeOf`
// at runtime, so without that gate these assertions are no-ops.
//
// The previous `expectTypeOf(entry.eventType).toEqualTypeOf<AuditEventType>()`
// could never hold — and silently guarded nothing while test files went
// unchecked. `AuditLogEntry["eventType"]` is the broad write-time shape
// (template-literal families like `chat.${string}`, `${AuditResource}.updated`),
// strictly WIDER than the curated flat `AuditEventType` union, so the two are
// not equal by design. These assertions test the relationships that actually
// hold instead.

describe("AuditLogEntry agent.memory_changed", () => {
  it("types the detail shape and keeps the event in the curated union", () => {
    // The detail shape required for an `agent.memory_changed` entry.
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "agent.memory_changed" }>["detail"]
    >().toEqualTypeOf<{
      agent: { id: string; name: string };
      file: string;
      addedLines: number;
      removedLines: number;
      byteSize: number;
    }>();
    // The event must remain a member of the curated AuditEventType union.
    expectTypeOf<"agent.memory_changed">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry channel.auto_disabled (#477 layer 2)", () => {
  it("types the detail shape and keeps the event in the curated union", () => {
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "channel.auto_disabled" }>["detail"]
    >().toEqualTypeOf<{
      channel: string;
      account: { id: string; name: string | null };
      reason: string;
      lastError: string | null;
    }>();
    expectTypeOf<"channel.auto_disabled">().toExtend<AuditEventType>();
  });
});

describe("AuditEventType is a subset of AuditLogEntry['eventType']", () => {
  it("every curated event type is one appendAuditLog can record", () => {
    // Intentionally NOT equal (the entry type is strictly broader), but the
    // curated list must stay a SUBSET of what an entry can carry — otherwise it
    // would advertise an event that appendAuditLog cannot actually write.
    expectTypeOf<AuditEventType>().toExtend<AuditLogEntry["eventType"]>();
  });
});
