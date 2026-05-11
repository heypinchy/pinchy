import { describe, it, expect } from "vitest";
import type { AuditLogEntry } from "@/lib/audit";

describe("file.upload audit events", () => {
  it("file.upload.staged is a valid event type", () => {
    const entry: AuditLogEntry = {
      eventType: "file.upload.staged",
      actorType: "user",
      actorId: "user-1",
      outcome: "success",
      detail: {
        uploadId: "00000000-0000-0000-0000-000000000001",
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        contentHash: "abc123",
        agent: { id: "agent-1", name: "Smithers" },
      },
    };
    expect(entry.eventType).toBe("file.upload.staged");
  });

  it("file.upload.attached carries messageId", () => {
    const entry: AuditLogEntry = {
      eventType: "file.upload.attached",
      actorType: "user",
      actorId: "user-1",
      outcome: "success",
      detail: {
        uploadId: "00000000-0000-0000-0000-000000000001",
        messageId: "msg-1",
        filename: "doc.pdf",
        agent: { id: "agent-1", name: "Smithers" },
      },
    };
    expect(entry.eventType).toBe("file.upload.attached");
  });

  it("file.upload.expired carries sweepId for batch correlation", () => {
    const entry: AuditLogEntry = {
      eventType: "file.upload.expired",
      actorType: "system",
      actorId: "upload-gc",
      outcome: "success",
      detail: {
        uploadId: "00000000-0000-0000-0000-000000000001",
        filename: "doc.pdf",
        sizeBytes: 1024,
        agedSeconds: 90000,
        sweepId: "sweep-1",
      },
    };
    expect(entry.eventType).toBe("file.upload.expired");
  });
});
