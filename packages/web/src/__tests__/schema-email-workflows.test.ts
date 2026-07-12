import { describe, it, expect } from "vitest";
import { emailWorkflows } from "@/db/schema";

const cols = (t: unknown) => (t as any)[Symbol.for("drizzle:Columns")];

describe("email_workflows schema", () => {
  it("has the expected columns", () => {
    expect(Object.keys(cols(emailWorkflows))).toEqual(
      expect.arrayContaining([
        "id",
        "agentId",
        "name",
        "filter",
        "action",
        "pollEvery",
        "sweepWindowDays",
        "enabled",
        "status",
        "openclawJobId",
        "createdBy",
        "createdAt",
        "updatedAt",
      ])
    );
  });
  it("requires agentId and defaults enabled=false, status=pending", () => {
    const c = cols(emailWorkflows);
    expect(c.agentId.notNull).toBe(true);
    expect(c.enabled.default).toBe(false);
    expect(c.status.default).toBe("pending");
  });
});
