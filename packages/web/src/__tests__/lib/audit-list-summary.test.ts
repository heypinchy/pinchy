import { describe, it, expect } from "vitest";
import { summarizeListForAudit, MAX_LIST_ITEMS_IN_AUDIT } from "@/lib/audit-list-summary";

describe("summarizeListForAudit", () => {
  it("keeps a list up to the cap as it is", () => {
    const items = Array.from({ length: MAX_LIST_ITEMS_IN_AUDIT }, (_, i) => `tool_${i}`);
    expect(summarizeListForAudit(items)).toEqual(items);
  });

  it("collapses a longer list to its count, so the detail stays under the 2048-byte cap", () => {
    const items = Array.from({ length: MAX_LIST_ITEMS_IN_AUDIT + 1 }, (_, i) => `tool_${i}`);
    expect(summarizeListForAudit(items)).toEqual({ count: MAX_LIST_ITEMS_IN_AUDIT + 1 });
  });
});
