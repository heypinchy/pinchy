import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWhere, mockSelect } = vi.hoisted(() => {
  const mockWhere = vi.fn();
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return { mockWhere, mockSelect };
});

vi.mock("@/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: {
    type: "type",
    status: "status",
    data: "data",
  },
}));

import { getActiveMcpPresets } from "@/lib/integrations/mcp-connections";

describe("getActiveMcpPresets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty set when no MCP connections exist", async () => {
    mockWhere.mockResolvedValue([]);
    const result = await getActiveMcpPresets();
    expect(result).toEqual(new Set());
  });

  it("returns the preset of every active connection", async () => {
    mockWhere.mockResolvedValue([{ data: { preset: "github" } }, { data: { preset: "linear" } }]);
    const result = await getActiveMcpPresets();
    expect(result).toEqual(new Set(["github", "linear"]));
  });

  it("de-duplicates presets across multiple connections of the same preset", async () => {
    mockWhere.mockResolvedValue([{ data: { preset: "github" } }, { data: { preset: "github" } }]);
    const result = await getActiveMcpPresets();
    expect(result).toEqual(new Set(["github"]));
  });

  it("ignores rows with a null or missing data column", async () => {
    mockWhere.mockResolvedValue([{ data: null }, { data: { preset: "linear" } }]);
    const result = await getActiveMcpPresets();
    expect(result).toEqual(new Set(["linear"]));
  });

  it("queries only mcp-type, active-status connections", async () => {
    mockWhere.mockResolvedValue([]);
    await getActiveMcpPresets();
    expect(mockWhere).toHaveBeenCalledTimes(1);
    // and(eq(type, "mcp"), eq(status, "active")) — assert on the drizzle SQL
    // shape indirectly via its serialized chunks, since the mocked schema
    // columns are plain strings rather than real drizzle Column objects.
    const condition = mockWhere.mock.calls[0][0];
    const serialized = JSON.stringify(condition);
    expect(serialized).toContain("mcp");
    expect(serialized).toContain("active");
  });
});
