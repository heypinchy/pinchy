import { describe, it, expect } from "vitest";
import { channelLinks } from "@/db/schema";

describe("channelLinks schema", () => {
  it("should have the expected columns", () => {
    const columns = Object.keys(channelLinks);
    expect(columns).toContain("id");
    expect(columns).toContain("userId");
    expect(columns).toContain("channel");
    expect(columns).toContain("channelUserId");
    expect(columns).toContain("linkedAt");
  });
});
