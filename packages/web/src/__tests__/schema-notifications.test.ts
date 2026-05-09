import { describe, it, expect } from "vitest";
import { notifications } from "@/db/schema";

describe("notifications schema", () => {
  it("has required columns", () => {
    const cols = notifications[Symbol.for("drizzle:Columns") as any];
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "agentId",
        "briefingRunId",
        "title",
        "content",
        "status",
        "errorMessage",
        "createdAt",
      ])
    );
  });
});
