import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { toolApproval, approvalTierEnum, approvalStatusEnum } from "../schema";

describe("tool_approval schema", () => {
  it("exposes the full approval-lifecycle column set", () => {
    const cols = Object.keys(getTableColumns(toolApproval)).sort();
    expect(cols).toEqual(
      [
        "id",
        "agentId",
        "requesterId",
        "sessionKey",
        "toolName",
        "argsDigest",
        "argsSummary",
        "tier",
        "status",
        "approverId",
        "decisionReason",
        "createdAt",
        "decidedAt",
        "consumedAt",
        "expiresAt",
      ].sort()
    );
  });

  it("defines the tier enum as confirm|escalate (escalate reserved for the deferred four-eyes tier)", () => {
    expect(approvalTierEnum.enumValues).toEqual(["confirm", "escalate"]);
  });

  it("defines the status lifecycle enum", () => {
    expect(approvalStatusEnum.enumValues).toEqual([
      "pending",
      "approved",
      "denied",
      "consumed",
      "expired",
    ]);
  });

  it("defaults a new request to tier=confirm, status=pending", () => {
    const cols = getTableColumns(toolApproval);
    expect(cols.tier.default).toBe("confirm");
    expect(cols.status.default).toBe("pending");
  });
});
