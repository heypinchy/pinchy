import { describe, it, expect } from "vitest";
import type { AuditLogEntry } from "@/lib/audit";

describe("diagnostics.exported audit event", () => {
  it("is a valid AuditLogEntry at compile + runtime", () => {
    const entry: AuditLogEntry = {
      actorType: "user",
      actorId: "usr_1",
      eventType: "diagnostics.exported",
      resource: "diagnostics:agt_1",
      detail: {
        agent: { id: "agt_1", name: "Smithers" },
        scope: { anchorTurnIndex: 5, includedTurnRange: [2, 5] },
        byteSize: 4321,
        droppedTurns: 0,
        truncated: false,
      },
      outcome: "success",
    };
    expect(entry.eventType).toBe("diagnostics.exported");
  });
});
