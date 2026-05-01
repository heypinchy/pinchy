import { describe, it, expect } from "vitest";
import { briefingRuns } from "@/db/schema";

describe("briefing_runs schema (slim — telemetry lives in OpenClaw)", () => {
  it("has exactly the expected state columns", () => {
    const cols = briefingRuns[Symbol.for("drizzle:Columns") as any];
    expect(Object.keys(cols).sort()).toEqual(
      [
        "id",
        "briefingId",
        "agentId",
        "openclawJobId",
        "openclawRunId",
        "openclawSessionKey",
        "runAtMs",
        "isTest",
        "notificationProcessedAt",
      ].sort()
    );
  });

  it("does NOT store telemetry columns (lives in OpenClaw)", () => {
    const cols = briefingRuns[Symbol.for("drizzle:Columns") as any];
    // Regression guard: these were on earlier designs; must not reappear.
    for (const forbidden of [
      "status",
      "errorMessage",
      "tokensInput",
      "tokensOutput",
      "output",
      "startedAt",
      "completedAt",
    ]) {
      expect(cols[forbidden]).toBeUndefined();
    }
  });

  it("has FK and unique constraints for idempotency", () => {
    const cols = briefingRuns[Symbol.for("drizzle:Columns") as any];
    expect(cols.briefingId.notNull).toBe(true);
    expect(cols.openclawRunId.notNull).toBe(true);
  });
});
