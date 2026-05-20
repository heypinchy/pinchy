import { describe, it, expect } from "vitest";
import { diagnosticsExportRequestSchema } from "@/lib/schemas/diagnostics";

describe("diagnosticsExportRequestSchema", () => {
  it("accepts a minimal valid request (agentId only, Settings-triggered)", () => {
    const r = diagnosticsExportRequestSchema.safeParse({ agentId: "agt_1" });
    expect(r.success).toBe(true);
  });

  it("accepts an anchor message id for per-message-triggered export", () => {
    const r = diagnosticsExportRequestSchema.safeParse({
      agentId: "agt_1",
      anchorMessageId: "msg_abc",
      userDescription: "Output stopped mid-stream",
    });
    expect(r.success).toBe(true);
  });

  it("rejects userDescription over 500 characters", () => {
    const r = diagnosticsExportRequestSchema.safeParse({
      agentId: "agt_1",
      userDescription: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing agentId", () => {
    const r = diagnosticsExportRequestSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
